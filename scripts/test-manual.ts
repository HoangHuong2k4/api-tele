console.log("HELLO START");
import { bankService } from './src/services/bank.service';
import axios from 'axios';

async function run() {
    console.log("Inside run()");
    const url = "https://thueapibank.vn/historyapiacbv2/88d3a0d5a38490c595d185490045cc75";
    const { data } = await axios.get(url);
    const txs: any[] = (data as any).transactions || [];
    console.log("API returned txs:", txs.length);
    const codes = new Set(["LUJVQE3EBHC3"]);
    
    for (const tx of txs) {
        if (tx.transactionID == "6275") {
            console.log("Found 6275. Processing...");
            const norm = {
                transactionID: tx.transactionID,
                amount: tx.amount,
                description: tx.description || tx.transName || tx.content,
                type: tx.type || 'IN'
            };
            await bankService.processTransaction(norm, { tenant_id: 5 }, codes);
            console.log("Done processing 6275");
        }
    }
    process.exit(0);
}
run();
