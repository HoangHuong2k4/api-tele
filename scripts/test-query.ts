import pool from './src/config/db';
import { TABLES } from './src/config/tables';

async function main() {
    const productId = 14;
    console.log("Checking product...");
    const [prod]: any = await pool.execute(`SELECT id, name, price FROM ${TABLES.PRODUCTS} WHERE id = ?`, [productId]);
    console.log("Product:", prod[0]);

    const [dealer]: any = await pool.execute(`SELECT price FROM ${TABLES.DEALER_PRICES} WHERE customer_id = 5050 AND product_id = ?`, [productId]);
    if (dealer.length) console.log("Dealer price:", dealer[0]);

    const comboId = 4;
    if (comboId) {
        const [combo]: any = await pool.execute(`SELECT * FROM ${TABLES.PRODUCT_COMBOS} WHERE id = ?`, [comboId]);
        console.log("Combo:", combo[0]);
    }

    process.exit(0);
}
main();
