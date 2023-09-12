import {
    compactSignature,
    fillWithMakingAmount,
    getOrderBuilder,
    getOrderFacade,
    getPredicateBuilder, skipMakerPermit,
} from './helpers/utils';
import { ether } from './helpers/utils';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { deployArbitraryPredicate, deploySwapTokens } from './helpers/fixtures';
import { ethers } from 'hardhat'
import { expect } from 'chai';
import {getPermit} from "./helpers/eip712";
import {getPermit2, permit2Contract, withTarget} from "@1inch/solidity-utils";

const getCurrentTime = () => Math.floor(Date.now() / 1000);

describe('LimitOrderProtocol',  () => {
    let addr, addr1;

    beforeEach(async function () {
        [addr, addr1] = await ethers.getSigners();
    });

    async function initContracts(dai, weth, swap) {
        await dai.mint(addr1.address, ether('1000000'));
        await dai.mint(addr.address, ether('1000000'));
        await weth.deposit({ value: ether('100') });
        await weth.connect(addr1).deposit({ value: ether('100') });
        await dai.approve(swap.address, ether('1000000'));
        await dai.connect(addr1).approve(swap.address, ether('1000000'));
        await weth.approve(swap.address, ether('100'));
        await weth.connect(addr1).approve(swap.address, ether('100'));
    }

    describe('wip', function () {
        const deployContractsAndInit = async function () {
            const { dai, weth, swap, chainId } = await deploySwapTokens();
            await initContracts(dai, weth, swap);
            return { dai, weth, swap, chainId };
        };

        it('transferFrom', async function () {
            const { dai } = await loadFixture(deployContractsAndInit);

            await dai.connect(addr1).approve(addr.address, '2');
            await dai.transferFrom(addr1.address, addr.address, '1');
        });

        it('should not swap with bad signature', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);
            const builder = getOrderBuilder(swap.address, addr);

            const order = builder.buildLimitOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: '1',
                takingAmount: '1',
                maker: addr.address,
            });

            const typedData = builder.buildLimitOrderTypedData(order.order, chainId, swap.address);
            const signature = await builder.buildOrderSignature(addr.address, typedData);

            const facade = getOrderFacade(swap.address, chainId, addr1)

            const calldata = facade.fillLimitOrder({
                order: order.order,
                amount: '1',
                signature,
                takerTraits: fillWithMakingAmount(BigInt(1))
            });

            const tx = await addr1.sendTransaction({
                to: swap.address,
                data: calldata
            });

            await tx.wait();

            const makerDai = await dai.balanceOf(addr.address);
            const takerDai = await dai.balanceOf(addr1.address);
            const makerWeth = await weth.balanceOf(addr.address);
            const takerWeth = await weth.balanceOf(addr1.address);
            // expect(await dai.balanceOf(addr1.address)).to.equal(makerDai.sub(1));
            expect(makerDai.toString()).to.equal('999999999999999999999999')
            expect(takerDai.toString()).to.equal('1000000000000000000000001')
            expect(makerWeth.toString()).to.equal('100000000000000000001')
            expect(takerWeth.toString()).to.equal('99999999999999999999')
        });

        it('should fill when not expired', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);
            const builder = getOrderBuilder(swap.address, addr1)

            const order = builder.buildLimitOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: '1',
                takingAmount: '1',
                maker: addr1.address,
                makerTraits: builder.buildMakerTraits({
                    expiry: getCurrentTime() + 3600
                }),
            });

            const typedData = builder.buildLimitOrderTypedData(order.order, chainId, swap.address);
            const signature = await builder.buildOrderSignature(addr.address, typedData);

            const facade = getOrderFacade(swap.address, chainId, addr)

            const calldata = facade.fillLimitOrder({
                order: order.order,
                amount: '1',
                signature,
                takerTraits: fillWithMakingAmount(BigInt(1))
            });

            const tx = await addr.sendTransaction({
                to: swap.address,
                data: calldata
            });

            await tx.wait();

            const makerDai = await dai.balanceOf(addr1.address);
            const takerDai = await dai.balanceOf(addr.address);
            const makerWeth = await weth.balanceOf(addr1.address);
            const takerWeth = await weth.balanceOf(addr.address);

            expect(makerDai.toString()).to.equal('999999999999999999999999')
            expect(takerDai.toString()).to.equal('1000000000000000000000001')
            expect(makerWeth.toString()).to.equal('100000000000000000001')
            expect(takerWeth.toString()).to.equal('99999999999999999999')
        });

        it('should not fill when expired', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);

            const builder = getOrderBuilder(swap.address, addr1)

            const order = builder.buildLimitOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: '1',
                takingAmount: '1',
                maker: addr1.address,
                makerTraits: builder.buildMakerTraits({ expiry: 0xff0000 }),
            });

            const typedData = builder.buildLimitOrderTypedData(order.order, chainId, swap.address);
            const signature = await builder.buildOrderSignature(addr.address, typedData);

            const facade = getOrderFacade(swap.address, chainId, addr);

            const calldata = facade.fillLimitOrder({
                order: order.order,
                amount: '1',
                signature,
                takerTraits: fillWithMakingAmount(BigInt(1))
            });

            await expect(addr.sendTransaction({
                to: swap.address,
                data: calldata
            })).to.be.revertedWithCustomError(swap, 'OrderExpired');
        });
    });

    describe('Order Cancelation', function () {
        const deployContractsAndInit = async function () {
            const { dai, weth, swap, chainId } = await deploySwapTokens();
            await initContracts(dai, weth, swap);
            return { dai, weth, swap, chainId };
        };

        const orderCancelationInit = async function () {
            const { dai, weth, swap, chainId } = await deployContractsAndInit();
            const builder = getOrderBuilder(swap.address, addr1);
            const order = builder.buildLimitOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: '1',
                takingAmount: '1',
                maker: addr1.address,
                makerTraits: builder.buildMakerTraits({ allowMultipleFills: true }),
            });
            return { dai, weth, swap, chainId, order, builder };
        };

        const orderWithEpochInit = async function () {
            const { dai, weth, swap, chainId } = await deployContractsAndInit();
            const builder = getOrderBuilder(swap.address, addr1);
            const order = builder.buildLimitOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: '2',
                takingAmount: '2',
                maker: addr1.address,
                makerTraits: builder.buildMakerTraits({ allowMultipleFills: true, shouldCheckEpoch: true, nonce: 0, series: 1 }),
            });
            return { dai, weth, swap, chainId, order, builder };
        };

        it('should cancel own order', async function () {
            const { swap, chainId, order, builder } = await loadFixture(orderCancelationInit);
            const data = builder.buildLimitOrderTypedData(order.order, chainId, swap.address);
            const orderHash = builder.buildLimitOrderHash(data);
            const orderFacade = getOrderFacade(swap.address, chainId, addr1);

            const calldata = orderFacade.cancelLimitOrder(order.order.makerTraits, orderHash);
            const tx = await addr1.sendTransaction({
                to: swap.address,
                data: calldata
            });

            await tx.wait();

            const remainingInvalidatorForOrderCalldata =
                orderFacade.remainingInvalidatorForOrder(addr1.address, orderHash);

            const provider = ethers.provider;
            const result = await provider.call({
                to: swap.address,
                data: remainingInvalidatorForOrderCalldata
            });

            expect(BigInt(result)).to.equal(BigInt(0))
        });


        it('epoch change, order should fail', async function () {
            const { swap, chainId, order, builder } = await loadFixture(orderWithEpochInit);

            await swap.connect(addr1).increaseEpoch(1);

            const typedData = builder.buildLimitOrderTypedData(order.order, chainId, swap.address);
            const signature = await builder.buildOrderSignature(addr1.address, typedData);

            const orderFacade = getOrderFacade(swap.address, chainId, addr1);
            const calldata = orderFacade.increaseEpoch('1');
            const tx = await addr1.sendTransaction({
                to: swap.address,
                data: calldata
            });

            await tx.wait();

            const fillCalldata = orderFacade.fillLimitOrder({
                order: order.order,
                signature,
                amount: '2',
                takerTraits: fillWithMakingAmount(BigInt(1))
            })

            await expect(addr1.sendTransaction({
                to: swap.address,
                data: fillCalldata
            })).to.be.revertedWithCustomError(swap, 'WrongSeriesNonce')
        });

        it('advance nonce', async function () {
            const { swap, chainId } = await loadFixture(deployContractsAndInit);

            const orderFacade = getOrderFacade(swap.address, chainId, addr);
            const calldata = orderFacade.increaseEpoch('0');
            const tx = await addr.sendTransaction({
                to: swap.address,
                data: calldata
            });

            await tx.wait();

            const epochCallData = orderFacade.epoch(addr.address, '0');

            const provider = ethers.provider;
            const result = BigInt(
                await provider.call({
                    to: swap.address,
                    data: epochCallData
                })
            )
            expect(result).to.equal(BigInt(1));
        });

    });

    describe('Predicate', function () {
        const deployContractsAndInit = async function () {
            const { dai, weth, swap, chainId } = await deploySwapTokens();
            const { arbitraryPredicate } = await deployArbitraryPredicate();
            await initContracts(dai, weth, swap);
            return { dai, weth, swap, chainId, arbitraryPredicate };
        };

        it('arbitrary call predicate should pass', async function () {
            const { dai, weth, swap, chainId, arbitraryPredicate } = await loadFixture(deployContractsAndInit);

            const predicateBuilder = getPredicateBuilder(
                swap.address, chainId, addr1
            )

            const arbitraryCalldata = predicateBuilder.arbitraryStaticCall(
                arbitraryPredicate.address,
                arbitraryPredicate.interface.encodeFunctionData('copyArg', [1]),
            );

            const predicate = predicateBuilder.lt(
                '10',
                arbitraryCalldata,
            )

            const builder = getOrderBuilder(swap.address, addr1);

            const order = builder.buildLimitOrder(
                {
                    makerAsset: dai.address,
                    takerAsset: weth.address,
                    makingAmount: '1',
                    takingAmount: '1',
                    maker: addr1.address,
                },
                {
                    predicate,
                },
            );

            const signature = await builder.buildTypedDataAndSign(
                order.order,
                chainId,
                swap.address,
                addr1.address
            );

            const takerFacade = getOrderFacade(swap.address, chainId, addr);

            const calldata = takerFacade.fillLimitOrderExt({
                order: order.order,
                amount: '1',
                signature,
                takerTraits: '1',
                extension: order.extension,
            });

            const tx = await addr.sendTransaction({
                to: swap.address,
                data: calldata
            });

            await tx.wait();

            await expect(tx).to.changeTokenBalances(dai, [addr, addr1], [1, -1]);
            await expect(tx).to.changeTokenBalances(weth, [addr, addr1], [-1, 1]);
        });

        it('arbitrary call predicate should fail', async function () {
            const { dai, weth, swap, chainId, arbitraryPredicate } = await loadFixture(deployContractsAndInit);

            const predicateBuilder = getPredicateBuilder(
                swap.address, chainId, addr1
            );

            const arbitraryCalldata = predicateBuilder.arbitraryStaticCall(
                arbitraryPredicate.address,
                arbitraryPredicate.interface.encodeFunctionData('copyArg', [1]),
            );

            const predicate = predicateBuilder.gt(
                '10',
                arbitraryCalldata,
            );

            const builder = getOrderBuilder(swap.address, addr1);

            const order = builder.buildLimitOrder(
                {
                    makerAsset: dai.address,
                    takerAsset: weth.address,
                    makingAmount: '1',
                    takingAmount: '1',
                    maker: addr1.address,
                },
                {
                    predicate,
                },
            );

            console.log('Test extension --', predicate, ' --Test');

            const signature = await builder.buildTypedDataAndSign(
                order.order,
                chainId,
                swap.address,
                addr1.address
            );

            const facade = getOrderFacade(
                swap.address,
                chainId,
                addr
            );

            const calldata = facade.fillLimitOrderExt({
                order: order.order,
                amount: '1',
                signature,
                takerTraits: '1',
                extension: order.extension,
            });

            await expect(addr.sendTransaction({
                to: swap.address,
                data: calldata
            })).to.be.revertedWithCustomError(swap, 'PredicateIsNotTrue');
        });

        it('`or` should pass', async function () {
            const { dai, weth, swap, chainId, arbitraryPredicate } = await loadFixture(deployContractsAndInit);

            const predicateBuilder = getPredicateBuilder(
                swap.address, chainId, addr1
            );

            const arbitraryCalldata = predicateBuilder.arbitraryStaticCall(
                arbitraryPredicate.address,
                arbitraryPredicate.interface.encodeFunctionData('copyArg', [1]),
            );

            const comparelt = predicateBuilder.lt('15', arbitraryCalldata);
            const comparegt = predicateBuilder.gt('5', arbitraryCalldata);

            const predicate = predicateBuilder.or(comparelt, comparegt);

            const builder = getOrderBuilder(
                swap.address,
                addr1
            );

            const order = builder.buildLimitOrder(
                {
                    makerAsset: dai.address,
                    takerAsset: weth.address,
                    makingAmount: '1',
                    takingAmount: '1',
                    maker: addr1.address,
                },
                {
                    predicate,
                },
            );

            const signature = await builder.buildTypedDataAndSign(
                order.order,
                chainId,
                swap.address,
                addr1
            );

            const facade = getOrderFacade(
                swap.address,
                chainId,
                addr1,
            );

            const fillCalldata = facade.fillLimitOrderExt({
                order: order.order,
                signature,
                extension: order.extension,
                amount: '1',
                takerTraits: '1'
            });

            const fillTx = await addr.sendTransaction({
                to: swap.address,
                data: fillCalldata,
            });
            await expect(fillTx).to.changeTokenBalances(dai, [addr, addr1], [1, -1]);
            await expect(fillTx).to.changeTokenBalances(weth, [addr, addr1], [-1, 1]);
        });

        it('`and` should pass', async function () {
            const { dai, weth, swap, chainId, arbitraryPredicate } = await loadFixture(deployContractsAndInit);

            const predicateBuilder = getPredicateBuilder(
                swap.address, chainId, addr1
            );

            const arbitraryCalldata = predicateBuilder.arbitraryStaticCall(
                arbitraryPredicate.address,
                arbitraryPredicate.interface.encodeFunctionData('copyArg', [1]),
            );

            const comparelt = predicateBuilder.lt('15', arbitraryCalldata);
            const comparegt = predicateBuilder.gt('5', arbitraryCalldata);

            const predicate = predicateBuilder.or(comparelt, comparegt);

            const builder = getOrderBuilder(
                swap.address,
                addr1
            );

            const order = builder.buildLimitOrder(
                {
                    makerAsset: dai.address,
                    takerAsset: weth.address,
                    makingAmount: '1',
                    takingAmount: '1',
                    maker: addr1.address,
                },
                {
                    predicate,
                },
            );

            const signature = await builder.buildTypedDataAndSign(
                order.order,
                chainId,
                swap.address,
                addr1
            );

            const facade = getOrderFacade(
                swap.address,
                chainId,
                addr1,
            );

            const fillCalldata = facade.fillLimitOrderExt({
                order: order.order,
                signature,
                extension: order.extension,
                amount: '1',
                takerTraits: '1'
            });

            const fillTx = await addr.sendTransaction({
                to: swap.address,
                data: fillCalldata,
            });

            await expect(fillTx).to.changeTokenBalances(dai, [addr, addr1], [1, -1]);
            await expect(fillTx).to.changeTokenBalances(weth, [addr, addr1], [-1, 1]);
        });
    });

    describe('Predicate with permit', function () {
        const deployContractsAndInit = async function () {
            const { dai, weth, swap, chainId } = await deploySwapTokens();
            const { arbitraryPredicate } = await deployArbitraryPredicate();
            await initContracts(dai, weth, swap);
            return { dai, weth, swap, chainId, arbitraryPredicate };
        };

        it('arbitrary call predicate with maker permit should pass', async function () {
            const { dai, weth, swap, chainId, arbitraryPredicate } = await loadFixture(deployContractsAndInit);

            const predicateBuilder = getPredicateBuilder(
                swap.address, chainId, addr
            )

            const arbitraryCalldata = predicateBuilder.arbitraryStaticCall(
                arbitraryPredicate.address,
                arbitraryPredicate.interface.encodeFunctionData('copyArg', [1]),
            );

            const predicate = predicateBuilder.lt(
                '10',
                arbitraryCalldata,
            )

            const permit = withTarget(
                weth.address,
                await getPermit(addr.address, addr, weth, '1', chainId, swap.address, '1'),
            );

            const builder = getOrderBuilder(swap.address, addr);

            const order = builder.buildLimitOrder(
                {
                    makerAsset: weth.address,
                    takerAsset: dai.address,
                    makingAmount: '1',
                    takingAmount: '1',
                    maker: addr.address,
                },
                {
                    predicate,
                    permit
                },
            );


            console.log(
                'predicate ', predicate,
                'permit ', permit,
                'extension ', order.extension
            )

            const signature = await builder.buildTypedDataAndSign(
                order.order,
                chainId,
                swap.address,
                addr.address
            );

            const takerFacade = getOrderFacade(swap.address, chainId, addr1);

            const calldata = takerFacade.fillLimitOrderExt({
                order: order.order,
                amount: '1',
                signature,
                takerTraits: fillWithMakingAmount(BigInt(1)),
                extension: order.extension,
            });

            const filltx = await addr1.sendTransaction({
                to: swap.address,
                data: calldata
            });

            await filltx.wait();

            await expect(filltx).to.changeTokenBalances(dai, [addr, addr1], [1, -1]);
            await expect(filltx).to.changeTokenBalances(weth, [addr, addr1], [-1, 1]);
        });
    })

    describe('Permit', function () {
        describe('fillOrderToWithPermit', function () {
            const deployContractsAndInitPermit = async function () {
                const { dai, weth, swap, chainId } = await deploySwapTokens();
                await initContracts(dai, weth, swap);

                const builder = getOrderBuilder(swap.address, addr1);

                const order = builder.buildLimitOrder({
                    makerAsset: dai.address,
                    takerAsset: weth.address,
                    makingAmount: '1',
                    takingAmount: '1',
                    maker: addr1.address,
                });
                const signature = await builder.buildTypedDataAndSign(order.order, chainId, swap.address, addr1.address);

                return { dai, weth, swap, chainId, order, signature };
            };

            it('DAI => WETH', async function () {
                const { dai, weth, swap, chainId, order, signature } = await loadFixture(deployContractsAndInitPermit);

                const permit = await getPermit(addr.address, addr, weth, '1', chainId, swap.address, '1');
                const { r, vs } = compactSignature(signature);

                // use facade for that
                const filltx = swap.fillOrderToWithPermit(order.order, r, vs, 1, fillWithMakingAmount(BigInt(1)), addr.address, permit, '0x');
                await expect(filltx).to.changeTokenBalances(dai, [addr, addr1], [1, -1]);
                await expect(filltx).to.changeTokenBalances(weth, [addr, addr1], [-1, 1]);
            });

            it('DAI => WETH, permit2 maker', async function () {
                const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInitPermit);

                const permit2 = await permit2Contract();
                await dai.connect(addr1).approve(permit2.address, 1);
                const permit = await getPermit2(addr1, dai.address, chainId, swap.address, BigInt(1));

                const builder = getOrderBuilder(swap.address, addr1)

                const order = builder.buildLimitOrder({
                    makerAsset: dai.address,
                    takerAsset: weth.address,
                    makingAmount: '1',
                    takingAmount: '1',
                    maker: addr1.address,
                    makerTraits: builder.buildMakerTraits({ usePermit2: true }),
                });

                const signature = await builder.buildTypedDataAndSign(order.order, chainId, swap.address, addr1.address);

                const { r, vs } = compactSignature(signature);
                const filltx = swap.fillOrderToWithPermit(order.order, r, vs, 1, fillWithMakingAmount(BigInt(1)), addr.address, permit, '0x');
                await expect(filltx).to.changeTokenBalances(dai, [addr, addr1], [1, -1]);
                await expect(filltx).to.changeTokenBalances(weth, [addr, addr1], [-1, 1]);
            });
        });

        describe('maker permit', function () {
            const deployContractsAndInitPermit = async function () {
                const { dai, weth, swap, chainId } = await deploySwapTokens();
                await initContracts(dai, weth, swap);

                const permit = withTarget(
                    weth.address,
                    await getPermit(addr.address, addr, weth, '1', chainId, swap.address, '1'),
                );

                const builder = getOrderBuilder(swap.address, addr)

                const order = builder.buildLimitOrder(
                    {
                        makerAsset: weth.address,
                        takerAsset: dai.address,
                        makingAmount: '1',
                        takingAmount: '1',
                        maker: addr.address,
                    },
                    {
                        permit,
                    },
                );

                const signature = await builder.buildTypedDataAndSign(order.order, chainId, swap.address, addr.address)
                return { dai, weth, swap, order, signature, permit, chainId };
            };

            it('maker permit works', async function () {
                const { dai, weth, swap, order, signature } = await loadFixture(deployContractsAndInitPermit);

                // const facade = getOrderFacade(swap.address, chainId, addr1)
                const { r, vs } = compactSignature(signature);
                // todo facade
                const filltx = swap.connect(addr1).fillOrderExt(order.order, r, vs, 1, fillWithMakingAmount(BigInt(1)), order.extension);
                await expect(filltx).to.changeTokenBalances(dai, [addr, addr1], [1, -1]);
                await expect(filltx).to.changeTokenBalances(weth, [addr, addr1], [-1, 1]);
            });

            it('skips order permit flag', async function () {
                const { dai, weth, swap, order, signature, permit } = await loadFixture(deployContractsAndInitPermit);

                const { r, vs } = compactSignature(signature);
                await addr1.sendTransaction({ to: weth.address, data: '0xd505accf' + permit.substring(42) });
                // todo facade
                const filltx = swap.connect(addr1).fillOrderExt(order.order, r, vs, 1, skipMakerPermit(BigInt(0)), order.extension);
                await expect(filltx).to.changeTokenBalances(dai, [addr, addr1], [1, -1]);
                await expect(filltx).to.changeTokenBalances(weth, [addr, addr1], [-1, 1]);
            });
        });
    });
});
