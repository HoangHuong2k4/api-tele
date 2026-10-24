import { bankService } from './src/services/bank.service';
import pool from './src/config/db';

async function run() {
    console.log("Starting sync...");
    await bankService.syncAllBanks();
    console.log("Sync done.");
    process.exit(0);
}
run();
