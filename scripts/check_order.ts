import pool from './src/config/db';
import { TABLES } from './src/config/tables';

async function main() {
    const code = 'JP8ULUFM2D2R';
    console.log("Checking order:", code);

    const [reqs]: any = await pool.execute(`SELECT * FROM ${TABLES.DEPOSIT_REQUESTS} WHERE payment_code = ?`, [code]);
    if (reqs.length === 0) {
        console.log("Order not found.");
    } else {
        console.log("Order details:");
        console.log(reqs[0]);
    }
    process.exit(0);
}
main().catch(console.error);
