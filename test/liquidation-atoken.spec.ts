import BigNumber from 'bignumber.js';

import {BRE} from '../helpers/misc-utils';
import {APPROVAL_AMOUNT_LENDING_POOL, MOCK_ETH_ADDRESS, oneEther} from '../helpers/constants';
import {convertToCurrencyDecimals} from '../helpers/contracts-helpers';
import {makeSuite} from './helpers/make-suite';
import {ProtocolErrors, RateMode} from '../helpers/types';

const {expect} = require('chai');

makeSuite('LendingPool liquidation - liquidator receiving aToken', (testEnv) => {
  const {
    HF_IS_NOT_BELLOW_THRESHOLD,
    INVALID_HF,
    USER_DID_NOT_BORROW_SPECIFIED,
    INVALID_COLLATERAL_TO_LIQUIDATE,
  } = ProtocolErrors;

  it('LIQUIDATION - Deposits ETH, borrows DAI/Check liquidation fails because health factor is above 1', async () => {
    const {dai, users,  pool, oracle} = testEnv;
    const depositor = users[0];
    const borrower = users[1];

    //mints DAI to depositor
    await dai.connect(depositor.signer).mint(await convertToCurrencyDecimals(dai.address, '1000'));

    //approve protocol to access depositor wallet
    await dai.connect(depositor.signer).approve(pool.address, APPROVAL_AMOUNT_LENDING_POOL);

    //user 1 deposits 1000 DAI
    const amountDAItoDeposit = await convertToCurrencyDecimals(dai.address, '1000');
    await pool.connect(depositor.signer).deposit(dai.address, amountDAItoDeposit, '0');

    //user 2 deposits 1 ETH
    const amountETHtoDeposit = await convertToCurrencyDecimals(MOCK_ETH_ADDRESS, '1');
    await pool
      .connect(borrower.signer)
      .deposit(MOCK_ETH_ADDRESS, amountETHtoDeposit, '0', {value: amountETHtoDeposit});

    await pool.connect(borrower.signer).deposit(MOCK_ETH_ADDRESS, amountETHtoDeposit, '0', {
      value: amountETHtoDeposit,
    });

    //user 2 borrows

    const userGlobalData = await pool.getUserAccountData(borrower.address);
    const daiPrice = await oracle.getAssetPrice(dai.address);

    const amountDAIToBorrow = await convertToCurrencyDecimals(
      dai.address,
      new BigNumber(userGlobalData.availableBorrowsETH.toString())
        .div(daiPrice.toString())
        .multipliedBy(0.95)
        .toFixed(0)
    );

    await pool
      .connect(borrower.signer)
      .borrow(dai.address, amountDAIToBorrow, RateMode.Variable, '0');

    const userGlobalDataAfter = await pool.getUserAccountData(borrower.address);
    console.log('userGlobalDataAfter.healthFactor', userGlobalDataAfter.healthFactor.toString());

    expect(userGlobalDataAfter.currentLiquidationThreshold).to.be.bignumber.equal(
      '80',
      'Invalid liquidation threshold'
    );

    //someone tries to liquidate user 2
    await expect(
      pool.liquidationCall(MOCK_ETH_ADDRESS, dai.address, borrower.address, 1, true)
    ).to.be.revertedWith(HF_IS_NOT_BELLOW_THRESHOLD);
  });

  it('LIQUIDATION - Drop the health factor below 1', async () => {
    const {dai, users, pool, oracle} = testEnv;
    const borrower = users[1];

    const daiPrice = await oracle.getAssetPrice(dai.address);

    //halving the price of ETH - means doubling the DAIETH exchange rate
    console.log('DAI price before', daiPrice.toString());

    await oracle.setAssetPrice(
      dai.address,
      new BigNumber(daiPrice.toString()).multipliedBy(1.15).toFixed(0)
    );
    console.log('DAI price after', (await oracle.getAssetPrice(dai.address)).toString());

    const userGlobalData = await pool.getUserAccountData(borrower.address);

    expect(userGlobalData.healthFactor).to.be.bignumber.lt(oneEther.toFixed(0), INVALID_HF);
  });

  it('LIQUIDATION - Tries to liquidate a different currency than the loan principal', async () => {
    const {pool, users} = testEnv;
    const borrower = users[1];
    //user 2 tries to borrow
    await expect(
      pool.liquidationCall(
        MOCK_ETH_ADDRESS,
        MOCK_ETH_ADDRESS,
        borrower.address,
        oneEther.toString(),
        true
      )
    ).revertedWith(USER_DID_NOT_BORROW_SPECIFIED);
  });

  it(
    'LIQUIDATION - Tries to liquidate a different ' + 'collateral than the borrower collateral',
    async () => {
      const {pool, dai, users} = testEnv;
      const borrower = users[1];

      await expect(
        pool.liquidationCall(dai.address, dai.address, borrower.address, oneEther.toString(), true)
      ).revertedWith(INVALID_COLLATERAL_TO_LIQUIDATE);
    }
  );

  it('LIQUIDATION - Liquidates the borrow', async () => {
    const {pool, dai,  users, addressesProvider, oracle} = testEnv;
    const borrower = users[1];

    //mints dai to the caller

    await dai.mint(await convertToCurrencyDecimals(dai.address, '1000'));

    //approve protocol to access depositor wallet
    await dai.approve(pool.address, APPROVAL_AMOUNT_LENDING_POOL);

    const userReserveDataBefore = await pool.getUserReserveData(dai.address, borrower.address);

    const daiReserveDataBefore = await pool.getReserveData(dai.address);
    const ethReserveDataBefore = await pool.getReserveData(MOCK_ETH_ADDRESS);

    const amountToLiquidate = new BigNumber(userReserveDataBefore.currentBorrowBalance.toString())
      .div(2)
      .toFixed(0);

    await pool.liquidationCall(
      MOCK_ETH_ADDRESS,
      dai.address,
      borrower.address,
      amountToLiquidate,
      true
    );

    const userReserveDataAfter = await pool.getUserReserveData(dai.address, borrower.address);

    const userGlobalDataAfter = await pool.getUserAccountData(borrower.address);

    const daiReserveDataAfter = await pool.getReserveData(dai.address);
    const ethReserveDataAfter = await pool.getReserveData(MOCK_ETH_ADDRESS);

    const feeAddress = await addressesProvider.getTokenDistributor();

    const feeAddressBalance = await BRE.ethers.provider.getBalance(feeAddress);

    const collateralPrice = (await oracle.getAssetPrice(MOCK_ETH_ADDRESS)).toString();
    const principalPrice = (await oracle.getAssetPrice(dai.address)).toString();

    const collateralDecimals = (await pool.getReserveDecimals(MOCK_ETH_ADDRESS)).toString();
    const principalDecimals = (await pool.getReserveDecimals(dai.address)).toString();

    const expectedCollateralLiquidated = new BigNumber(principalPrice)
      .times(new BigNumber(amountToLiquidate).times(105))
      .times(new BigNumber(10).pow(collateralDecimals))
      .div(new BigNumber(collateralPrice).times(new BigNumber(10).pow(principalDecimals)))
      .decimalPlaces(0, BigNumber.ROUND_DOWN);

    const expectedFeeLiquidated = new BigNumber(principalPrice)
      .times(new BigNumber(userReserveDataBefore.originationFee.toString()).times(105))
      .times(new BigNumber(10).pow(collateralDecimals))
      .div(new BigNumber(collateralPrice).times(new BigNumber(10).pow(principalDecimals)))
      .div(100)
      .decimalPlaces(0, BigNumber.ROUND_DOWN);

    expect(userGlobalDataAfter.healthFactor).to.be.bignumber.gt(
      oneEther.toFixed(0),
      'Invalid health factor'
    );

    expect(userReserveDataAfter.originationFee).to.be.bignumber.eq(
      '0',
      'Origination fee should be repaid'
    );

    expect(feeAddressBalance).to.be.bignumber.gt('0');

    expect(userReserveDataAfter.principalBorrowBalance).to.be.bignumber.almostEqual(
      new BigNumber(userReserveDataBefore.currentBorrowBalance.toString())
        .minus(amountToLiquidate)
        .toFixed(0),
      'Invalid user borrow balance after liquidation'
    );

    expect(daiReserveDataAfter.availableLiquidity).to.be.bignumber.almostEqual(
      new BigNumber(daiReserveDataBefore.availableLiquidity.toString())
        .plus(amountToLiquidate)
        .toFixed(0),
      'Invalid principal available liquidity'
    );

    expect(ethReserveDataAfter.availableLiquidity).to.be.bignumber.almostEqual(
      new BigNumber(ethReserveDataBefore.availableLiquidity.toString())
        .minus(expectedFeeLiquidated)
        .toFixed(0),
      'Invalid collateral available liquidity'
    );
  });

  it(
    'User 3 deposits 1000 USDC, user 4 1 ETH,' +
      ' user 4 borrows - drops HF, liquidates the borrow',
    async () => {
      const {users,  pool, usdc, oracle, addressesProvider} = testEnv;
      const depositor = users[3];
      const borrower = users[4];
      //mints USDC to depositor
      await usdc
        .connect(depositor.signer)
        .mint(await convertToCurrencyDecimals(usdc.address, '1000'));

      //approve protocol to access depositor wallet
      await usdc.connect(depositor.signer).approve(pool.address, APPROVAL_AMOUNT_LENDING_POOL);

      //user 3 deposits 1000 USDC
      const amountUSDCtoDeposit = await convertToCurrencyDecimals(usdc.address, '1000');

      await pool.connect(depositor.signer).deposit(usdc.address, amountUSDCtoDeposit, '0');

      //user 4 deposits 1 ETH
      const amountETHtoDeposit = await convertToCurrencyDecimals(MOCK_ETH_ADDRESS, '1');

      await pool.connect(borrower.signer).deposit(MOCK_ETH_ADDRESS, amountETHtoDeposit, '0', {
        value: amountETHtoDeposit,
      });

      //user 4 borrows
      const userGlobalData = await pool.getUserAccountData(borrower.address);

      const usdcPrice = await oracle.getAssetPrice(usdc.address);

      const amountUSDCToBorrow = await convertToCurrencyDecimals(
        usdc.address,
        new BigNumber(userGlobalData.availableBorrowsETH.toString())
          .div(usdcPrice.toString())
          .multipliedBy(0.95)
          .toFixed(0)
      );

      await pool
        .connect(borrower.signer)
        .borrow(usdc.address, amountUSDCToBorrow, RateMode.Stable, '0');

      //drops HF below 1

      await oracle.setAssetPrice(
        usdc.address,
        new BigNumber(usdcPrice.toString()).multipliedBy(1.2).toFixed(0)
      );

      //mints dai to the liquidator

      await usdc.mint(await convertToCurrencyDecimals(usdc.address, '1000'));

      //approve protocol to access depositor wallet
      await usdc.approve(pool.address, APPROVAL_AMOUNT_LENDING_POOL);

      const userReserveDataBefore = await pool.getUserReserveData(usdc.address, borrower.address);

      const usdcReserveDataBefore = await pool.getReserveData(usdc.address);
      const ethReserveDataBefore = await pool.getReserveData(MOCK_ETH_ADDRESS);

      const amountToLiquidate = new BigNumber(userReserveDataBefore.currentBorrowBalance.toString())
        .div(2)
        .toFixed(0);

      await pool.liquidationCall(
        MOCK_ETH_ADDRESS,
        usdc.address,
        borrower.address,
        amountToLiquidate,
        true
      );

      const userReserveDataAfter = await pool.getUserReserveData(usdc.address, borrower.address);

      const userGlobalDataAfter = await pool.getUserAccountData(borrower.address);

      const usdcReserveDataAfter = await pool.getReserveData(usdc.address);
      const ethReserveDataAfter = await pool.getReserveData(MOCK_ETH_ADDRESS);

      const feeAddress = await addressesProvider.getTokenDistributor();

      const feeAddressBalance = await BRE.ethers.provider.getBalance(feeAddress);

      const collateralPrice = (await oracle.getAssetPrice(MOCK_ETH_ADDRESS)).toString();
      const principalPrice = (await oracle.getAssetPrice(usdc.address)).toString();

      const collateralDecimals = (await pool.getReserveDecimals(MOCK_ETH_ADDRESS)).toString();
      const principalDecimals = (await pool.getReserveDecimals(usdc.address)).toString();

      const expectedCollateralLiquidated = new BigNumber(principalPrice)
        .times(new BigNumber(amountToLiquidate).times(105))
        .times(new BigNumber(10).pow(collateralDecimals))
        .div(new BigNumber(collateralPrice).times(new BigNumber(10).pow(principalDecimals)))
        .decimalPlaces(0, BigNumber.ROUND_DOWN);

      const expectedFeeLiquidated = new BigNumber(principalPrice)
        .times(new BigNumber(userReserveDataBefore.originationFee.toString()).times(105))
        .times(new BigNumber(10).pow(collateralDecimals))
        .div(new BigNumber(collateralPrice).times(new BigNumber(10).pow(principalDecimals)))
        .div(100)
        .decimalPlaces(0, BigNumber.ROUND_DOWN);

      expect(userGlobalDataAfter.healthFactor).to.be.bignumber.gt(
        oneEther.toFixed(0),
        'Invalid health factor'
      );

      expect(userReserveDataAfter.originationFee).to.be.bignumber.eq(
        '0',
        'Origination fee should be repaid'
      );

      expect(feeAddressBalance).to.be.bignumber.gt('0');

      expect(userReserveDataAfter.principalBorrowBalance).to.be.bignumber.almostEqual(
        new BigNumber(userReserveDataBefore.currentBorrowBalance.toString())
          .minus(amountToLiquidate)
          .toFixed(0),
        'Invalid user borrow balance after liquidation'
      );

      expect(usdcReserveDataAfter.availableLiquidity).to.be.bignumber.almostEqual(
        new BigNumber(usdcReserveDataBefore.availableLiquidity.toString())
          .plus(amountToLiquidate)
          .toFixed(0),
        'Invalid principal available liquidity'
      );

      expect(ethReserveDataAfter.availableLiquidity).to.be.bignumber.almostEqual(
        new BigNumber(ethReserveDataBefore.availableLiquidity.toString())
          .minus(expectedFeeLiquidated)
          .toFixed(0),
        'Invalid collateral available liquidity'
      );
    }
  );
});
