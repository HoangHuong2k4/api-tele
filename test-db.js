require('dotenv').config();
const mysql = require('mysql2/promise');
async function test() {
    try {
        const pool = mysql.createPool({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER,
            password: process.env.DB_PASS,
            database: process.env.DB_NAME
        });
        const [rows] = await pool.execute('SELECT 1+1 AS result');
        console.log('Success:', rows);
        process.exit(0);
    } catch(e) {
        console.error('Error:', e);
        process.exit(1);
    }
}
test();
