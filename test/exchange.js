/* global  artifacts:true, web3: true, contract: true */
import chai from 'chai'
import { soliditySha3 as keccak256 } from 'web3-utils'
import { expectRevert, advanceNBlocks } from './helpers'
import { getOrderHash,
  getTradeHash,
  getMatchOrderAddresses,
  getMatchOrderValues,
  getWithdrawalHash,
  getCancelOrderValues,
  getCancelOrderAddresses } from './utils/exchange.js'

import Web3 from 'web3'
import BN from 'bn.js'
import bnChai from 'bn-chai'
import { ether } from './constants'

chai
.use(require('chai-bignumber')(web3.BigNumber))
.use(bnChai(require('bn.js')))
.should()

const Exchange = artifacts.require('./Exchange.sol')
const Token = artifacts.require('./utils/Token.sol')
const expect = chai.expect

contract('Exchange', (accounts) => {
  let web3 = new Web3('http://localhost:8545');
  let admin = accounts[0]
  let feeAccount = accounts[1]
  let trader1 = accounts[2]
  let trader2 = accounts[3]
  let asshole = accounts[4]
  let privateKey1 = '0x2bdd21761a483f71054e14f5b827213567971c676928d9a1808cbfa4b7501202'
  let privateKey2 = '0x2bdd21761a483f71054e14f5b827213567971c676928d9a1808cbfa4b7501203'
  let exchange
  let token1
  let token2
  let amount

  beforeEach(async() => {
    exchange = await Exchange.new(feeAccount)
  })

  describe('Operator functions', async () => {
    it('should set the fee account', async () => {
      let expectedNewFeeAccount = accounts[3]
      await exchange.setFeeAccount(expectedNewFeeAccount)
      let newFeeAccount = await exchange.feeAccount.call()
      newFeeAccount.should.be.equal(expectedNewFeeAccount)
    })

    it('should set the admin account', async () => {
      let newOperator = accounts[3]
      await exchange.setOperator(newOperator, true)

      let isOperator = await exchange.operators.call(newOperator)
      isOperator.should.be.equal(true)

      await exchange.setOperator(newOperator, false)

      isOperator = await exchange.operators.call(newOperator)
      isOperator.should.be.equal(false)
    })

    it('should set the withdrawal security period', async () => {
      await exchange.setWithdrawalSecurityPeriod(100000)
      let withdrawalSecurityPeriod = await exchange.withdrawalSecurityPeriod.call()
      withdrawalSecurityPeriod.should.be.bignumber.equal(100000)
    })
  })

  describe('Deposit', async () => {
    beforeEach(async () => {
      exchange = await Exchange.new(feeAccount)
      token1 = await Token.new(trader1, 1000)
      await token1.approve(exchange.address, 1000, { from: trader1 })
    })

    it('should be able to deposit tokens', async () => {
      await exchange.depositToken(token1.address, 1000, {from: trader1})
      let depositedTokens = await exchange.tokenBalance(trader1, token1.address)
      depositedTokens.should.be.bignumber.equal(1000)
    })

    it('should be able to deposit ether', async () => {
      await exchange.depositEther({from: trader1, value: 1 * 1e8})
      let depositedEther = await exchange.etherBalance(trader1)
      depositedEther.should.be.bignumber.equal(1 * 1e8)
    })
  })

  describe('Withdraw deposit', async () => {
    beforeEach(async () => {
      exchange = await Exchange.new(feeAccount)
      token1 = await Token.new(trader1, 1000)
      await exchange.setWithdrawalSecurityPeriod(10)
    })

    it('trader1 should be able to withdraw tokens after withdrawal period', async () => {
      await token1.approve(exchange.address, 1000, { from: trader1 })
      await exchange.depositToken(token1.address, 1000, {from: trader1 })

      await advanceNBlocks(web3, 10)
      await exchange.securityWithdraw(token1.address, 1000, { from: trader1 })
      let tokenBalance = await token1.balanceOf(trader1)
      tokenBalance.should.be.bignumber.equal(1000)

      let exchangeTokenBalance = await exchange.tokenBalance(trader1, token1.address)
      exchangeTokenBalance.should.be.bignumber.equal(0)
    })

    it('trader1 should be able to withdraw ether after withdrawal period', async () => {
      await exchange.depositEther({ from: trader1, value: 1e18 })
      let initialEtherBalance = await web3.eth.getBalance(trader1)
      let value = web3.utils.toBN(1e18)
      initialEtherBalance = web3.utils.toBN(initialEtherBalance)

      await advanceNBlocks(web3, 20)
      let txn = await exchange.securityWithdraw(0x0, 1e18, { from: trader1, gasPrice: 2e9 })
      let txnFee = web3.utils.toBN(2e9 * txn.receipt.gasUsed)

      let etherBalance = await web3.eth.getBalance(trader1)
      etherBalance = web3.utils.toBN(etherBalance)

      let expectedEtherBalance = initialEtherBalance.add(value).sub(txnFee)
      expect(etherBalance).to.eq.BN(expectedEtherBalance)
    })

    it('should not be able make a withdraw tokens/ether before the security period', async () => {
      await token1.approve(exchange.address, 1000, { from: trader1 })
      await exchange.depositToken(token1.address, 1000, { from: trader1 })
      await advanceNBlocks(web3, 5)
      await expectRevert(exchange.securityWithdraw(token1.address, 1000, { from: trader1 }))
    })

    it('operator with a signed message should be able to withdraw', async () => {
      await token1.approve(exchange.address, 1000, { from: trader1 })
      await exchange.depositToken(token1.address, 1000, { from: trader1 })

      let withdrawal = {
        token: token1.address,
        amount: 1000,
        trader: trader1,
        receiver: trader1,
        nonce: 0,
      }

      let feeWithdrawal = 0
      let withdrawalHash = getWithdrawalHash(exchange, withdrawal)
      let { message, messageHash, r, s, v } = web3.eth.accounts.sign(withdrawalHash, privateKey1)

      await exchange.withdraw(
        withdrawal.token,
        withdrawal.amount,
        withdrawal.trader,
        withdrawal.receiver,
        withdrawal.nonce,
        v,
        [r, s],
        feeWithdrawal)

      let tokenBalance = await token1.balanceOf(trader1)
      tokenBalance.should.be.bignumber.equal(1000)

      let exchangeTokenBalance = await exchange.tokenBalance(trader1, token1.address)
      exchangeTokenBalance.should.be.bignumber.equal(0)
    })
  })

  describe('Trading', async () => {
    beforeEach(async () => {
      exchange = await Exchange.new(feeAccount)
      token1 = await Token.new(trader1, 1000)
      token2 = await Token.new(trader2, 500)

      await token1.approve(exchange.address, 1000, { from: trader1 })
      await exchange.depositToken(token1.address, 1000, { from: trader1 })

      await token2.approve(exchange.address, 500, { from: trader2 })
      await exchange.depositToken(token2.address, 500, { from: trader2 })
    })

    it('should execute a trade (if order is not expired)', async () => {
      let initialBlockNumber = await web3.eth.getBlockNumber()

      let order = {
        amountBuy: 1000,
        amountSell: 1000,
        expires: initialBlockNumber+10,
        nonce: 0,
        feeMake: 10,
        feeTake: 10,
        tokenBuy: token2.address,
        tokenSell: token1.address,
        maker: trader1
      }

      let trade = {
        amount: 500,
        tradeNonce: 0,
        taker: trader2
      }

      let orderHash = getOrderHash(exchange, order)
      let tradeHash = getTradeHash(orderHash, trade)

      let { message: message1, messageHash: messageHash1, r: r1, s: s1, v: v1 } = web3.eth.accounts.sign(orderHash, privateKey1)
      let { message: message2, messageHash: messageHash2, r: r2, s: s2, v: v2 } = web3.eth.accounts.sign(tradeHash, privateKey2)

      let orderValues = getMatchOrderValues(order, trade)
      let orderAddresses = getMatchOrderAddresses(order, trade)

      await exchange.executeTrade(
        orderValues,
        orderAddresses,
        [v1, v2],
        [r1, s1, r2, s2]
      )

      let trader1BalanceOfToken1 = await exchange.tokenBalance(trader1, token1.address)
      let trader1BalanceOfToken2 = await exchange.tokenBalance(trader1, token2.address)
      let trader2BalanceOfToken1 = await exchange.tokenBalance(trader2, token1.address)
      let trader2BalanceOfToken2 = await exchange.tokenBalance(trader2, token2.address)

      trader1BalanceOfToken1.should.be.bignumber.equal(500)
      trader1BalanceOfToken2.should.be.bignumber.equal(500)
      trader2BalanceOfToken1.should.be.bignumber.equal(500)
      trader2BalanceOfToken2.should.be.bignumber.equal(0)
    })

    it('should not execute a trade if the order is expired', async () => {
      let initialBlockNumber = await web3.eth.getBlockNumber()

      let order = {
          amountBuy: 1000,
          amountSell: 1000,
          expires: initialBlockNumber-1,
          nonce: 0,
          feeMake: 10,
          feeTake: 10,
          tokenBuy: token2.address,
          tokenSell: token1.address,
          maker: trader1
        }

        let trade = {
          amount: 500,
          tradeNonce: 0,
          taker: trader2
        }

        let orderHash = getOrderHash(exchange, order)
        let tradeHash = getTradeHash(orderHash, trade)

        let { message: message1, messageHash: messageHash1, r: r1, s: s1, v: v1 } = web3.eth.accounts.sign(orderHash, privateKey1)
        let { message: message2, messageHash: messageHash2, r: r2, s: s2, v: v2 } = web3.eth.accounts.sign(tradeHash, privateKey2)

        let orderValues = getMatchOrderValues(order, trade)
        let orderAddresses = getMatchOrderAddresses(order, trade)

        await exchange.executeTrade(
          orderValues,
          orderAddresses,
          [v1, v2],
          [r1, s1, r2, s2]
        )

        let trader1BalanceOfToken1 = await exchange.tokenBalance(trader1, token1.address)
        let trader1BalanceOfToken2 = await exchange.tokenBalance(trader1, token2.address)
        let trader2BalanceOfToken1 = await exchange.tokenBalance(trader2, token1.address)
        let trader2BalanceOfToken2 = await exchange.tokenBalance(trader2, token2.address)

        trader1BalanceOfToken1.should.be.bignumber.equal(1000)
        trader1BalanceOfToken2.should.be.bignumber.equal(0)
        trader2BalanceOfToken1.should.be.bignumber.equal(0)
        trader2BalanceOfToken2.should.be.bignumber.equal(500)
    })
  })

  describe('Canceling orders and trades', async () => {
    beforeEach(async() => {
      exchange = await Exchange.new(feeAccount)
      token1 = await Token.new(trader1, 1000)
      token2 = await Token.new(trader2, 500)

      await token1.approve(exchange.address, 1000, { from: trader1 })
      await exchange.depositToken(token1.address, 1000, { from: trader1 })

      await token2.approve(exchange.address, 500, { from: trader2 })
      await exchange.depositToken(token2.address, 500, { from: trader2 })
    })

    it('should cancel an order', async () => {
      let initialBlockNumber = await web3.eth.getBlockNumber()

      let order = {
        amountBuy: 1000,
        amountSell: 1000,
        expires: initialBlockNumber+10,
        nonce: 0,
        feeMake: 10,
        feeTake: 10,
        tokenBuy: token2.address,
        tokenSell: token1.address,
        maker: trader1
      }

      let orderHash = getOrderHash(exchange, order)
      let cancelOrderValues = getCancelOrderValues(order)
      let cancelOrderAddresses = getCancelOrderAddresses(order)

      let orderAddresses = [
        order.tokenBuy,
        order.tokenSell,
        order.maker,
      ]

      let { message: message1, messageHash: messageHash1, r, s, v } = web3.eth.accounts.sign(orderHash, privateKey1)

      await exchange.cancelOrder(
        cancelOrderValues,
        cancelOrderAddresses,
        v,
        r,
        s,
        { from: trader1 })

      let orderFill = await exchange.orderFills.call(orderHash)
      orderFill.should.be.bignumber.equal(order.amountBuy)
    })

    it('should fail if the provided signature is invalid', async () => {
      let initialBlockNumber = await web3.eth.getBlockNumber()

      let order = {
        amountBuy: 1000,
        amountSell: 1000,
        expires: initialBlockNumber+10,
        nonce: 0,
        feeMake: 10,
        feeTake: 10,
        tokenBuy: token2.address,
        tokenSell: token1.address,
        maker: trader1
      }

      let orderHash = getOrderHash(exchange, order)
      let cancelOrderValues = getCancelOrderValues(order)
      let cancelOrderAddresses = getCancelOrderAddresses(order)

      let { message: message1, messageHash: messageHash1, r, s, v } = web3.eth.accounts.sign(orderHash, privateKey1)

      await exchange.cancelOrder(
        cancelOrderValues,
        cancelOrderAddresses,
        v,
        r,
        s,
        { from: asshole })

      let orderFill = await exchange.orderFills.call(orderHash)
      orderFill.should.be.bignumber.equal(0)
    })

    it('should cancel a trade', async () => {
      let initialBlockNumber = await web3.eth.getBlockNumber()

      let order = {
        amountBuy: 1000,
        amountSell: 1000,
        expires: initialBlockNumber+10,
        nonce: 0,
        feeMake: 10,
        feeTake: 10,
        tokenBuy: token2.address,
        tokenSell: token1.address,
        maker: trader1
      }

      let trade = {
        amount: 500,
        tradeNonce: 0,
        taker: trader2
      }

      let orderHash = getOrderHash(exchange, order)
      let tradeHash = getTradeHash(orderHash, trade)

      let { message: message1, messageHash: messageHash1, r: r1, s: s1, v: v1 } = web3.eth.accounts.sign(orderHash, privateKey1)
      let { message: message2, messageHash: messageHash2, r: r2, s: s2, v: v2 } = web3.eth.accounts.sign(tradeHash, privateKey2)

      await exchange.cancelTrade(
        orderHash,
        trade.amount,
        trade.tradeNonce,
        trade.taker,
        v2,
        r2,
        s2,
        { from: trader2 })

      let tradeCanceled = await exchange.traded.call(tradeHash)
      tradeCanceled.should.be.equal(true)
    })

    it('canceling a trade should fail if the provided signature is invalid', async () => {
      let initialBlockNumber = await web3.eth.getBlockNumber()

      let order = {
        amountBuy: 1000,
        amountSell: 1000,
        expires: initialBlockNumber+10,
        nonce: 0,
        feeMake: 10,
        feeTake: 10,
        tokenBuy: token2.address,
        tokenSell: token1.address,
        maker: trader1
      }

      let trade = {
        amount: 500,
        tradeNonce: 0,
        taker: trader2
      }

      let orderHash = getOrderHash(exchange, order)
      let tradeHash = getTradeHash(orderHash, trade)

      let { message: message1, messageHash: messageHash1, r: r1, s: s1, v: v1 } = web3.eth.accounts.sign(orderHash, privateKey1)
      let { message: message2, messageHash: messageHash2, r: r2, s: s2, v: v2 } = web3.eth.accounts.sign(tradeHash, privateKey2)

      await exchange.cancelTrade(
        orderHash,
        trade.amount,
        trade.tradeNonce,
        trade.taker,
        v2,
        r2,
        s2,
        { from: asshole })

      let tradeCanceled = await exchange.traded.call(tradeHash)
      tradeCanceled.should.be.equal(false)
    })

    it('executing a trade should fail if the trade has been canceled', async () => {
      let initialBlockNumber = await web3.eth.getBlockNumber()

      let order = {
        amountBuy: 1000,
        amountSell: 1000,
        expires: initialBlockNumber+10,
        nonce: 0,
        feeMake: 10,
        feeTake: 10,
        tokenBuy: token2.address,
        tokenSell: token1.address,
        maker: trader1
      }

      let trade = {
        amount: 500,
        tradeNonce: 0,
        taker: trader2
      }

      let orderHash = getOrderHash(exchange, order)
      let tradeHash = getTradeHash(orderHash, trade)

      let { message: message1, messageHash: messageHash1, r: r1, s: s1, v: v1 } = web3.eth.accounts.sign(orderHash, privateKey1)
      let { message: message2, messageHash: messageHash2, r: r2, s: s2, v: v2 } = web3.eth.accounts.sign(tradeHash, privateKey2)

      let orderValues = getMatchOrderValues(order, trade)
      let orderAddresses = getMatchOrderAddresses(order, trade)

      await exchange.cancelTrade(
        orderHash,
        trade.amount,
        trade.tradeNonce,
        trade.taker,
        v2,
        r2,
        s2,
        { from: trader2 })

      await exchange.executeTrade(
        orderValues,
        orderAddresses,
        [v1, v2],
        [r1, s1, r2, s2])

      let trader1BalanceOfToken1 = await exchange.tokenBalance(trader1, token1.address)
      let trader1BalanceOfToken2 = await exchange.tokenBalance(trader1, token2.address)
      let trader2BalanceOfToken1 = await exchange.tokenBalance(trader2, token1.address)
      let trader2BalanceOfToken2 = await exchange.tokenBalance(trader2, token2.address)

      trader1BalanceOfToken1.should.be.bignumber.equal(1000)
      trader1BalanceOfToken2.should.be.bignumber.equal(0)
      trader2BalanceOfToken1.should.be.bignumber.equal(0)
      trader2BalanceOfToken2.should.be.bignumber.equal(500)
    })
  })
})