import { bankService } from './src/services/bank.service';
import pool from './src/config/db';
bankService.syncAllBanks().then(() => {
    console.log("Sync done");
    process.exit(0);
});
