import abi from '../ethereum/ethereum.abi.json';
import { logger } from '../../services/logger';
import { Contract, Transaction, Wallet } from 'ethers';
import { EthereumBase } from '../ethereum/ethereum-base';
import { getEthereumConfig as getBaseConfig } from '../ethereum/ethereum.config';
import { Provider } from '@ethersproject/abstract-provider';
import { UniswapConfig } from '../../connectors/uniswap/uniswap.config';
import { Ethereumish } from '../../services/common-interfaces';
import { ConfigManagerV2 } from '../../services/config-manager-v2';
import { EVMController } from '../ethereum/evm.controllers';

export class Base extends EthereumBase implements Ethereumish {
  private static _instances: { [name: string]: Base };
  private _gasPrice: number;
  private _nativeTokenSymbol: string;
  private _chain: string;
  public controller;

  private constructor(network: string) {
    const config = getBaseConfig('base', network);
    super(
      'base',
      config.network.chainID,
      config.network.nodeURL,
      config.network.tokenListSource,
      config.network.tokenListType,
      config.manualGasPrice,
      config.gasLimitTransaction,
      ConfigManagerV2.getInstance().get('server.nonceDbPath'),
      ConfigManagerV2.getInstance().get('server.transactionDbPath')
    );
    this._chain = config.network.name;
    this._nativeTokenSymbol = config.nativeCurrencySymbol;
    this._gasPrice = config.manualGasPrice;
    this.controller = EVMController;
  }

  public static getInstance(network: string): Base {
    if (Base._instances === undefined) {
      Base._instances = {};
    }
    if (!(network in Base._instances)) {
      Base._instances[network] = new Base(network);
    }

    return Base._instances[network];
  }

  public static getConnectedInstances(): { [name: string]: Base } {
    return Base._instances;
  }

  public get gasPrice(): number {
    return this._gasPrice;
  }

  public get nativeTokenSymbol(): string {
    return this._nativeTokenSymbol;
  }

  public get chain(): string {
    return this._chain;
  }

  getContract(tokenAddress: string, signerOrProvider?: Wallet | Provider) {
    return new Contract(tokenAddress, abi.ERC20Abi, signerOrProvider);
  }

  getSpender(reqSpender: string): string {
    let spender: string;
    if (reqSpender === 'uniswap') {
      spender = UniswapConfig.config.uniswapV3SmartOrderRouterAddress(
        this._chain
      );
    } else if (reqSpender === 'uniswapLP') {
      spender = UniswapConfig.config.uniswapV3NftManagerAddress(this._chain);
    } else {
      spender = reqSpender;
    }
    return spender;
  }

  // cancel transaction
  async cancelTx(wallet: Wallet, nonce: number): Promise<Transaction> {
    logger.info(
      'Canceling any existing transaction(s) with nonce number ' + nonce + '.'
    );
    return super.cancelTxWithGasPrice(wallet, nonce, this._gasPrice * 2);
  }
}
