import pool from './src/config/db';
import { TABLES } from './src/config/tables';

async function main() {
    const code = 'LPFVUQEWS4HQ';
    console.log("Starting cancellation process for:", code);

    const [reqs]: any = await pool.execute(`SELECT * FROM ${TABLES.DEPOSIT_REQUESTS} WHERE payment_code = ?`, [code]);
    if (reqs.length === 0) {
        console.log("Not found.");
        process.exit(1);
    }
    const req = reqs[0];
    const amount = parseFloat(req.amount);
    
    // Update balance
    const [users]: any = await pool.execute(`SELECT balance FROM ${TABLES.CUSTOMERS} WHERE id = ? FOR UPDATE`, [req.customer_id]);
    const user = users[0];
    const newBalance = parseFloat(user.balance) - amount;

    if (newBalance >= 0) {
        await pool.execute(`UPDATE ${TABLES.CUSTOMERS} SET balance = ? WHERE id = ?`, [newBalance, req.customer_id]);
        console.log(`Deducted ${amount} from customer ${req.customer_id}. New balance: ${newBalance}`);

        // Insert log
        await pool.execute(
            `INSERT INTO ${TABLES.BALANCE_LOGS} (tenant_id, customer_id, amount, type, note, created_at, updated_at) VALUES (?, ?, ?, 'OUT', ?, NOW(), NOW())`,
            [req.tenant_id, req.customer_id, amount, 'Admin hoàn tiền/Huỷ đơn (mã: ' + code + ')']
        );
    } else {
        console.log(`User does not have enough balance (${user.balance}) to deduct ${amount}.`);
    }

    await pool.execute(`UPDATE ${TABLES.DEPOSIT_REQUESTS} SET status = 'failed' WHERE id = ?`, [req.id]);
    console.log("Updated deposit request to failed.");

    process.exit(0);
}
main().catch(console.error);
