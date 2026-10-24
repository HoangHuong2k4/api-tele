import pool from './src/config/db';
import { TABLES } from './src/config/tables';

async function main() {
    const amount = 60000;
    const tenant_id = 5;
    console.log(`Checking bank_webhooks for amount: ${amount} and tenant_id: ${tenant_id}`);

    const [hooks]: any = await pool.execute(`SELECT * FROM ${TABLES.BANK_WEBHOOKS} WHERE amount = ? AND tenant_id = ? ORDER BY id DESC LIMIT 5`, [amount, tenant_id]);
    if (hooks.length === 0) {
        console.log("No webhooks found for this amount.");
    } else {
        console.log(`Found ${hooks.length} webhooks:`);
        hooks.forEach((h: any) => console.log(`ID: ${h.id}, Description: ${h.description}, Date: ${h.created_at}`));
    }
    process.exit(0);
}
main().catch(console.error);
