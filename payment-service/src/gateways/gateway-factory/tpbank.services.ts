import { axios } from 'src/shards/helpers/axios';
import * as moment from 'moment-timezone';
import * as https from 'https';
import * as crypto from 'crypto';
import { Injectable } from '@nestjs/common';

import { GateType, Payment } from '../gate.interface';
import { Gate } from '../gates.services';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { sleep } from 'src/shards/helpers/sleep';

const API_BASE_URL = 'https://ebank.tpb.vn';
const API_ENDPOINTS = {
  LOGIN: `${API_BASE_URL}/gateway/api/auth/login/v4/non-trust`,
  TRANSACTIONS: `${API_BASE_URL}/gateway/api/smart-search-presentation-service/v2/account-transactions/find`,
};

const DEFAULT_HEADERS = {
  APP_VERSION: '2026.01.30',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'vi',
  Connection: 'keep-alive',
  'Content-Type': 'application/json',
  DEVICE_NAME: 'Chrome',
  Origin: API_BASE_URL,
  PLATFORM_NAME: 'WEB',
  PLATFORM_VERSION: '145',
  SOURCE_APP: 'HYDRO',
  USER_NAME: 'HYD',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
};

@Injectable()
export class TPBankService extends Gate {
  private accessToken: string | null | undefined;

  private deviceId: string;

  private clearAccessTokenTimeout: NodeJS.Timeout | null = null;
  getAgent() {
    if (this.proxy != null) {
      if (this.proxy.username && this.proxy.username.length > 0) {
        return new HttpsProxyAgent(
          `${this.proxy.schema}://${this.proxy.username}:${this.proxy.password}@${this.proxy.ip}:${this.proxy.port}`,
        );
      }
      return new HttpsProxyAgent(
        `${this.proxy.schema}://${this.proxy.ip}:${this.proxy.port}`,
      );
    }
    return new https.Agent({
      secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
    });
  }

  private async login() {
    this.deviceId = this.config.device_id;

    const dataSend = {
      username: this.config.login_id,
      password: this.config.password,
      step_2FA: 'VERIFY',
      deviceId: this.deviceId,
      transactionId: '',
    };
    const config = {
      headers: {
        ...DEFAULT_HEADERS,
        Authorization: 'Bearer',
        DEVICE_ID: this.deviceId,
        Referer: `${API_BASE_URL}/retail/vX/`,
      },
    };
    try {
      const response = await axios.post(
        API_ENDPOINTS.LOGIN,
        dataSend,
        { ...config, httpsAgent: this.getAgent() } as any,
      );
      this.accessToken = (response.data as any).access_token;

      if (this.clearAccessTokenTimeout)
        clearTimeout(this.clearAccessTokenTimeout);

      this.clearAccessTokenTimeout = setTimeout(
        () => {
          this.accessToken = null;
        },
        ((response.data as any).expires_in - 10) * 1000,
      );

      if (!this.accessToken) {
        console.log('Không có token');
      } else {
        console.log('Đã lấy được token');
      }
    } catch (error) {
      console.error('Login failed:', error);
      throw new Error('Login failed');
    }
  }

  async getHistory(): Promise<Payment[]> {
    if (!this.accessToken) await this.login();
    const fromDate = moment()
      .tz('Asia/Ho_Chi_Minh')
      .subtract(this.config.get_transaction_day_limit, 'days')
      .format('YYYYMMDD');
    const toDate = moment().tz('Asia/Ho_Chi_Minh').format('YYYYMMDD');

    const config = {
      headers: {
        ...DEFAULT_HEADERS,
        'Accept-Language': 'vi,en-US;q=0.9,en;q=0.8',
        Authorization: `Bearer ${this.accessToken}`,
        DEVICE_ID: this.deviceId,
      },
    };

    const dataSend = {
      pageNumber: 1,
      pageSize: this.config.get_transaction_count_limit,
      accountNo: this.config.account,
      currency: 'VND',
      maxAcentrysrno: '',
      fromDate: fromDate,
      toDate: toDate,
      keyword: '',
    };

    try {
      const response = await axios.post(
        API_ENDPOINTS.TRANSACTIONS,
        dataSend,
        { ...config, httpsAgent: this.getAgent() } as any,
      );

      const transactionInfosList = (response.data as any).transactionInfos || [];

      // Lọc các giao dịch có creditDebitIndicator là 'CRDT'
      const filteredTransactions = transactionInfosList.filter(
        (transactionInfo) => transactionInfo.creditDebitIndicator === 'CRDT',
      );
      // Chuyển đổi các giao dịch đã lọc thành định dạng mới
      const transactionsWithout = filteredTransactions.map(
        (transactionInfos) => ({
          transaction_id: 'tbbank-' + transactionInfos.id,
          amount: Number(transactionInfos.amount),
          content: transactionInfos.description,
          date: moment
            .tz(transactionInfos.bookingDate, 'YYYY-MM-DD', 'Asia/Ho_Chi_Minh')
            .toDate(),
          account_receiver: this.config.account,
          gate: GateType.TPBANK,
        }),
      );
      return transactionsWithout;
    } catch (error) {
      console.error('Error while fetching transaction history:', error);
      if (error.response) {
        console.error('Error response:', error.response.data);
      }
      if (
        error.message.includes(
          'Client network socket disconnected before secure TLS connection was established',
        )
      ) {
        await sleep(10000);
      } else {
        this.accessToken = null;
      }

      throw new Error('Error while fetching transaction history');
    }
  }
}
