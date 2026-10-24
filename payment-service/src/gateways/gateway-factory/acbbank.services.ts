import * as fs from 'fs';
import { parse } from 'node-html-parser';
import * as moment from 'moment-timezone';
import * as playwright from 'playwright';
import * as _request from 'request-promise';
import { GateType, Payment } from '../gate.interface';

import { Gate } from '../gates.services';
import { sleep } from 'src/shards/helpers/sleep';
import { axios } from 'src/shards/helpers/axios';
export class ACBBankService extends Gate {
  private jar: _request.CookieJar;
  private request: _request.RequestPromiseAPI | undefined = undefined;
  private dse_sessionId: string | undefined;
  private dse_processorId: string | undefined;
  private user_agent: string | undefined;
  getProxyString() {
    if (this.proxy) {
      if (this.proxy.username && this.proxy.username.length > 0) {
        return `${this.proxy.schema}://${this.proxy.username}:${this.proxy.password}@${this.proxy.ip}:${this.proxy.port}`;
      }
      return `${this.proxy.schema}://${this.proxy.ip}:${this.proxy.port}`;
    }
    return undefined;
  }

  getChromProxy() {
    if (!this.proxy) {
      return undefined;
    }

    return {
      server: `${this.proxy.ip}:${this.proxy.port}`,
      username: this.proxy.username,
      password: this.proxy.password,
    };
  }

  async randomUserAgent(): Promise<string> {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36';
  }

  parseAcbHistory(html: string): Payment[] {
    const document = parse(html);
    const table = document.getElementById('table1');
    const rows = table.querySelectorAll('tr');

    const payments: Payment[] = [];

    // Skip header row
    for (let i = 1; i < rows.length - 1; i += 2) {
      try {
        const transactionRow = rows[i];
        const contentRow = rows[i + 1];

        const tds = transactionRow.querySelectorAll('td');

        // Check if this is a valid transaction row (should have 6 columns)
        if (tds.length === 6) {
          const date = tds[1].text.trim();

          const debitAmount = tds[3].text.trim();
          const creditAmount = tds[4].text.trim();

          // Get content from the next row (colspan=4)
          const contentCell = contentRow.querySelector('td[colspan="4"]');
          const content = contentCell ? contentCell.text.trim() : '';

          const transactionId = tds[2].text.trim();

          // Determine amount - credit
          const amount = parseInt(creditAmount.replace(/\./g, ''));

          // Only add if we have a valid date and amount
          if (date && !debitAmount && !isNaN(amount)) {
            payments.push({
              // 01/11/2024 23:37:01
              date: moment
                .tz(date, 'DD/MM/YYYY HH:mm:ss', 'Asia/Ho_Chi_Minh')
                .toDate(),
              transaction_id: 'acbbank-' + transactionId,
              amount: amount,
              content: content,
              gate: GateType.ACBBANK,
              account_receiver: this.config.account,
            });
          }
        }
      } catch (error) {
        console.error('Error processing row:', error);
        // Continue processing other rows even if one fails
        continue;
      }
    }

    return payments;
  }

  async login() {
    const browser = await playwright.chromium.launch({
      headless: true,
      proxy: this.getChromProxy(),
    });
    this.user_agent = await this.randomUserAgent();
    try {
      const contextOptions: playwright.BrowserContextOptions = {
        userAgent: this.user_agent,
      };
      if (fs.existsSync('/app/state/storageState.json')) {
        contextOptions.storageState = '/app/state/storageState.json';
      }
      const context = await browser.newContext(contextOptions);
      const page = await context.newPage();

      // Tiết kiệm băng thông
      if (this.proxy)
        await page.route('**/*', async (route) => {
          const url = route.request().url();
          const resourceType = route.request().resourceType();

          if (url.includes('Captcha.jpg')) {
            return route.continue();
          }
          if (['image', 'media'].includes(resourceType)) {
            return route.abort();
          }

          if (![`xhr`, `fetch`, `document`].includes(resourceType)) {
            try {
              const response = await axios.get(url, {
                responseType: 'arraybuffer',
              });
              return route.fulfill({
                status: response.status,
                headers: {},
                body: Buffer.from(response.data as any),
              });
            } catch (error) {
              return route.abort();
            }
          }
          route.continue();
        });

      const getCaptchaWaitResponse = page.waitForResponse('**/Captcha.jpg');
      await page.goto('https://online.acb.com.vn/acbib/Request');

      // fake fingerprint
      await page.evaluate(() => {
        // Fixed platform
        Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });

        // Fixed screen resolution
        Object.defineProperty(screen, 'width', { get: () => 1920 });
        Object.defineProperty(screen, 'height', { get: () => 1080 });

        // Fixed device memory
        Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

        // Fixed language
        Object.defineProperty(navigator, 'language', { get: () => 'vi-VN' });

        // Fixed color depth
        Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
      });

      await page.getByLabel('Tên truy cập').click();
      await page.getByLabel('Tên truy cập').fill(this.config.login_id);
      await page.getByLabel('Mật khẩu').click();
      await page.getByLabel('Mật khẩu').fill(this.config.password);
      await page.getByLabel('Mật khẩu').press('Tab');

      const getCaptchaBuffer = await getCaptchaWaitResponse.then((d) =>
        d.body(),
      );
      const captchaBase64 = getCaptchaBuffer.toString('base64');
      const captchaText = await this.captchaSolver.solveCaptcha(captchaBase64);

      await sleep(5000);
      await page.locator('#security-code').fill(captchaText);
      await page.locator('#security-code').press('Enter');

      await sleep(3000);

      const pageText = await page.evaluate(() => document.body.innerText || '');
      if (pageText.includes('Mã xác thực không đúng') || pageText.includes('Mã xác nhận không đúng')) {
          throw new Error('ACB Login Error: Invalid Captcha');
      }
      if (pageText.includes('Mật khẩu không đúng') || pageText.includes('Tên truy cập không tồn tại') || pageText.includes('Tên đăng nhập không đúng')) {
          throw new Error('ACB Login Error: Invalid Credentials');
      }

      let linkMyAccount;
      let linkMyAccountHref;
      try {
        linkMyAccount = await page.getByText(this.config.account, { exact: false });
        await linkMyAccount.waitFor({ timeout: 30000 });
        linkMyAccountHref = await linkMyAccount.getAttribute('href');
      } catch (e) {
        try {
          const isOtpPage = await page.getByText('OTP Safekey nâng cao').isVisible();
          if (isOtpPage) {
            console.log('OTP Safekey challenge detected!');
            await page.getByRole('button', { name: /TIẾP TỤC/i }).click();
            await page.waitForTimeout(3000);
            await page.screenshot({ path: '/app/state/acb_otp_input.png' });
            // also copy to web root for easy viewing
            try { fs.copyFileSync('/app/state/acb_otp_input.png', '/home/huong/web/cms.cataishop.shop/public_html/acb_otp_input.png'); } catch(e){}
            console.log('Waiting for OTP in /app/state/otp.txt... You have 120 seconds to provide it.');
            
            if (fs.existsSync('/app/state/otp.txt')) { fs.unlinkSync('/app/state/otp.txt'); }
            let otp = '';
            for(let i = 0; i < 60; i++) {
                if (fs.existsSync('/app/state/otp.txt')) {
                    otp = fs.readFileSync('/app/state/otp.txt', 'utf8').trim();
                    if (otp.length >= 6) {
                        fs.unlinkSync('/app/state/otp.txt');
                        break;
                    }
                }
                await page.waitForTimeout(2000);
            }
            if (otp) {
               console.log('OTP received! Filling...');
               await page.evaluate((otpCode) => {
                   const inputs = Array.from(document.querySelectorAll('input'));
                   const visibleInputs = inputs.filter(i => (i as any).offsetWidth > 0 && (i as any).offsetHeight > 0 && !i.disabled && !i.readOnly && i.type !== 'hidden' && i.type !== 'submit' && i.type !== 'button');
                   if (visibleInputs.length > 0) {
                       visibleInputs[0].value = otpCode;
                       visibleInputs[0].dispatchEvent(new Event('input', { bubbles: true }));
                       visibleInputs[0].dispatchEvent(new Event('change', { bubbles: true }));
                   }
               }, otp);
               await page.waitForTimeout(1000);
               await page.screenshot({ path: '/app/acb_otp_filled.png' });
               await page.evaluate(() => {
                   const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a.btn'));
                   const nextBtn = buttons.find(b => {
                       const text = (b.textContent || (b as any).value || '').toLowerCase();
                       return text.includes('tiếp') || text.includes('xác nhận') || text.includes('đồng ý');
                   });
                   if (nextBtn) (nextBtn as any).click();
               });
               await page.waitForTimeout(5000);
               linkMyAccount = await page.getByText(this.config.account, { exact: false });
               await linkMyAccount.waitFor({ timeout: 15000 });
               linkMyAccountHref = await linkMyAccount.getAttribute('href');
            } else {
               throw new Error('OTP timeout!');
            }
          } else {
            throw e;
          }
        } catch (innerErr) {
          await page.screenshot({ path: '/app/acb_error.png' });
          throw innerErr;
        }
      }

      if (fs.existsSync('/app/state')) {
        await context.storageState({ path: '/app/state/storageState.json' });
      }

      const cookie = await context.cookies();
      this.jar = _request.jar();
      for (const c of cookie) {
        this.jar.setCookie(`${c.name}=${c.value}`, 'https://' + c.domain);
      }
      this.request = _request.defaults({
        jar: this.jar,
        headers: {
          'User-Agent': this.user_agent,
        },
        followRedirect: true,
        followAllRedirects: true,
      });

      const dashboardPageHtml = await this.request(
        `https://online.acb.com.vn/acbib/${linkMyAccountHref}`,
        { proxy: this.getProxyString() },
      );
      // await fs.promises.writeFile('acb1.1.html', dashboardPageHtml);

      this.dse_sessionId =
        /<input type="hidden" name="dse_sessionId" value="(.*?)"/gm.exec(
          dashboardPageHtml,
        )?.[1];
      this.dse_processorId =
        /<input type="hidden" name="dse_processorId" value="(.*?)"/gm.exec(
          dashboardPageHtml,
        )?.[1];

      //close
      await browser.close();
    } catch (error) {
      await browser.close();
      console.error('ACBBankService login error', error);
      throw error;
    }
  }

  async getHistory(): Promise<Payment[]> {
    if (!this.dse_sessionId) {
      await this.login();
      await sleep(1000);
    }

    const fromDate = moment()
      .tz('Asia/Ho_Chi_Minh')
      .subtract(this.config.get_transaction_day_limit, 'days')
      .format('DD/MM/YYYY');
    const toDate = moment()
      .add(1, 'day')
      .tz('Asia/Ho_Chi_Minh')
      .format('DD/MM/YYYY');

    const dataSend = {
      dse_sessionId: this.dse_sessionId,
      dse_applicationId: '-1',
      dse_operationName: 'ibkacctDetailProc',
      dse_pageId: '4',
      dse_processorState: 'acctDetailPage',
      dse_processorId: this.dse_processorId,
      dse_errorPage: '/ibk/acctinquiry/trans.jsp',
      AccountNbr: this.config.account,
      virtualAccount: '',
      storeName: '',
      CheckRef: 'false',
      EdtRef: '',
      activeDatetimeYN: 'N',
      dse_nextEventName: 'byDate',
      FromDate: fromDate,
      ToDate: toDate,
    };

    try {
      const historyPageHtml = await this.request({
        uri: 'https://online.acb.com.vn/acbib/Request',
        method: 'POST',
        form: dataSend,
        proxy: this.getProxyString(),
      });
      // await fs.promises.writeFile('acb2.2.html', historyPageHtml);

      const payments = this.parseAcbHistory(historyPageHtml);

      return payments;
    } catch (error) {
      console.error(error);

      try {
        await this.login();
      } catch (error) {
        console.error(error);
      }

      throw error;
    }
  }
}
