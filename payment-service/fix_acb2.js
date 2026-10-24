const fs = require('fs');

let content = fs.readFileSync('src/gateways/gateway-factory/acbbank.services.ts', 'utf8');

// replace the screenshot saving to save it to /app/state/
content = content.replace(/await page\.screenshot\(\{ path: '\/app\/acb_otp_input\.png' \}\);/g, `await page.screenshot({ path: '/app/state/acb_otp_input.png' });
            // also copy to web root for easy viewing
            try { fs.copyFileSync('/app/state/acb_otp_input.png', '/home/huong/web/cms.cataishop.shop/public_html/acb_otp_input.png'); } catch(e){}`);

// clear otp.txt before waiting
content = content.replace(/let otp = '';/g, `if (fs.existsSync('/app/state/otp.txt')) { fs.unlinkSync('/app/state/otp.txt'); }
            let otp = '';`);

fs.writeFileSync('src/gateways/gateway-factory/acbbank.services.ts', content);
