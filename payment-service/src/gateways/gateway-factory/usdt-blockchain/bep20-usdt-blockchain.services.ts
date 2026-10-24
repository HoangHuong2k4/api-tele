import { Injectable } from '@nestjs/common';
import { axios } from 'src/shards/helpers/axios';
import { GateType, Payment } from '../../gate.interface';
import { Gate } from '../../gates.services';
import {
  BinanceP2PExchangeUsdtVnd,
  ExchangeUsdtVnd,
} from './exchange-usdt-vnd';

import * as moment from 'moment-timezone';
@Injectable()
export class Bep20UsdtBlockchainService extends Gate {
  private exchangeUsdtVnd: ExchangeUsdtVnd | null;

  getUsdtFromTransactionValueAndTokenDecimals(
    value: string,
    decimals: number,
  ): number {
    const usdt = +value / Math.pow(10, decimals);
    // 38845405000000000000  => 38.845405
    return Math.round(usdt * Math.pow(10, 10)) / Math.pow(10, 10);
  }

  async getHistory(): Promise<Payment[]> {
    if (!this.exchangeUsdtVnd)
      this.exchangeUsdtVnd = new BinanceP2PExchangeUsdtVnd(
        this.proxyService,
        this.config.proxy,
      );

    try {
      await this.exchangeUsdtVnd.updateExchangeRate();
      const httpsAgent = await this.getProxyAgent();

      // BSC API endpoint for BEP20 token transactions
      const transactions = await axios.get<BscTransaction>(
        'https://api.etherscan.io/v2/api',
        {
          params: {
            chainid: '56',
            module: 'account',
            action: 'tokentx',
            address: this.config.account,
            sort: 'desc',
            apikey: this.config.password,
            page: 1,
            offset: this.config.get_transaction_count_limit,
          },
          httpsAgent,
        } as any,
      );

      const TETHER_USD_CONTRACT_ADDRESS = '0x55d398326f99059ff775485246999027b3197955';
      const transactionFilterUsdtAndInbound = transactions.data.result.filter(
        (transaction) =>
          transaction.contractAddress === TETHER_USD_CONTRACT_ADDRESS &&
          transaction.to.toLowerCase() === this.config.account.toLowerCase() &&
          moment().diff(
            moment(parseInt(transaction.timeStamp) * 1000),
            'days',
          ) <= this.config.get_transaction_day_limit,
      );

      const payments: Payment[] = transactionFilterUsdtAndInbound.map(
        (transaction) => {
          const usdt = this.getUsdtFromTransactionValueAndTokenDecimals(
            transaction.value,
            transaction.tokenDecimal,
          );
          const vnd = this.exchangeUsdtVnd.usdtToVnd(usdt);
          return {
            transaction_id: transaction.hash,
            content: `Received ${usdt} usdt (${vnd} vnd) from ${transaction.from}`,
            amount: vnd,
            date: new Date(parseInt(transaction.timeStamp) * 1000),
            gate: GateType.BEP20_USDT_BLOCKCHAIN,
            account_receiver: this.config.account,
          };
        },
      );

      return payments;
    } catch (error) {
      console.error('Error while fetching BEP20 transaction history:', error);
      throw new Error('Error while fetching BEP20 transaction history');
    }
  }
}

interface BscTransaction {
  status: string;
  message: string;
  result: BscTransactionData[];
}

interface BscTransactionData {
  hash: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string;
  tokenName: string;
  tokenSymbol: string;
  tokenDecimal: number;
  contractAddress: string;
}
