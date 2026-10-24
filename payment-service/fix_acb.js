const fs = require('fs');

let content = fs.readFileSync('src/gateways/gateway-factory/acbbank.services.ts', 'utf8');

// 1. randomUserAgent
content = content.replace(/async randomUserAgent\(\): Promise<string> \{[\s\S]*?return \([\s\S]*?\);\n  \}/, `async randomUserAgent(): Promise<string> {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36';
  }`);

// 2. context
content = content.replace(/const context = await browser.newContext\(\{\s*userAgent: this.user_agent,\s*\}\);/, `const contextOptions: playwright.BrowserContextOptions = {
        userAgent: this.user_agent,
      };
      if (fs.existsSync('/app/state/storageState.json')) {
        contextOptions.storageState = '/app/state/storageState.json';
      }
      const context = await browser.newContext(contextOptions);`);

// 3. fake fingerprint
content = content.replace(/\/\/ Helper function for random values[\s\S]*?Object\.defineProperty\(screen, 'colorDepth', \{[\s\S]*?\}\);/, `// Fixed platform
        Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });

        // Fixed screen resolution
        Object.defineProperty(screen, 'width', { get: () => 1920 });
        Object.defineProperty(screen, 'height', { get: () => 1080 });

        // Fixed device memory
        Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

        // Fixed language
        Object.defineProperty(navigator, 'language', { get: () => 'vi-VN' });

        // Fixed color depth
        Object.defineProperty(screen, 'colorDepth', { get: () => 24 });`);

// 4. OTP Logic
content = content.replace(/let linkMyAccount;[\s\S]*?\} catch \(e\) \{[\s\S]*?await page.screenshot\(\{ path: '\/app\/acb_error.png' \}\);[\s\S]*?throw e;[\s\S]*?\}/, `let linkMyAccount;
      let linkMyAccountHref;
      try {
        linkMyAccount = await page.getByText(this.config.account, { exact: false });
        await linkMyAccount.waitFor({ timeout: 15000 });
        linkMyAccountHref = await linkMyAccount.getAttribute('href');
      } catch (e) {
        try {
          const isOtpPage = await page.getByText('OTP Safekey nâng cao').isVisible();
          if (isOtpPage) {
            console.log('OTP Safekey challenge detected!');
            await page.getByRole('button', { name: /TIẾP TỤC/i }).click();
            await page.waitForTimeout(3000);
            await page.screenshot({ path: '/app/acb_otp_input.png' });
            console.log('Waiting for OTP in /app/state/otp.txt... You have 120 seconds to provide it.');
            
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
      }`);

fs.writeFileSync('src/gateways/gateway-factory/acbbank.services.ts', content);
