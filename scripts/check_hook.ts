import pool from './src/config/db';
import { TABLES } from './src/config/tables';

async function main() {
    const code = 'JP8ULUFM2D2R';
    console.log("Checking bank_webhooks for:", code);

    const [hooks]: any = await pool.execute(`SELECT * FROM ${TABLES.BANK_WEBHOOKS} WHERE description LIKE ?`, [`%${code}%`]);
    if (hooks.length === 0) {
        console.log("No webhooks found for this code.");
    } else {
        console.log(`Found ${hooks.length} webhooks:`);
        console.log(hooks);
    }
    process.exit(0);
}
main().catch(console.error);
