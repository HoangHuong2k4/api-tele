const fs = require('fs');
const file = './src/services/telegram.service.ts';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(
    /if\s*\(\s*user\s*\)\s*\{\s*const\s*\[dealerRows\]:\s*any\s*=\s*await\s*pool\.execute\(`SELECT price, price_usd FROM \$\{TABLES\.DEALER_PRICES\}/g,
    'if (user && user.is_dealer) {\n                const [dealerRows]: any = await pool.execute(`SELECT price, price_usd FROM ${TABLES.DEALER_PRICES}'
);

code = code.replace(
    /const\s*\[dealerRows\]:\s*any\s*=\s*await\s*pool\.execute\(`SELECT price, price_usd FROM \$\{TABLES\.DEALER_PRICES\}/g,
    'let dealerRows: any = [];\n        if (user && user.is_dealer) {\n            [dealerRows] = await pool.execute(`SELECT price, price_usd FROM ${TABLES.DEALER_PRICES}'
);

fs.writeFileSync(file + '.bak', code);
console.log("Made backup and created fixes. Check manually.");
