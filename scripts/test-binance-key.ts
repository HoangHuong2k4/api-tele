import axios from 'axios';
import * as crypto from 'crypto';

async function test() {
    const apiKey = '5by6bMpye7L9ByfcnyHnfaTgahw7UAoBNLh5uP1vj8dlsHtQVZRUabBqxqz6rInx';
    const secretKey = 'GpVPVFDppFRApQPjhCDBkwPk0a2Of0NOgh5RwiaxWV5SePvD8yyTB2Up7grPQ6m8';

    try {
        const { data: timeData } = await axios.get('https://api.binance.com/api/v3/time');
        const timestamp = timeData.serverTime;
        let qs = `coin=USDT&status=1&timestamp=${timestamp}&recvWindow=60000`;
        qs += `&signature=${crypto.createHmac('sha256', secretKey).update(qs).digest('hex')}`;
        
        const { data } = await axios.get(`https://api.binance.com/sapi/v1/capital/deposit/hisrec?${qs}`, {
            headers: { 'X-MBX-APIKEY': apiKey }
        });
        console.log("Success! Length:", data.length);
    } catch (e: any) {
        console.log("Error:", e.response?.data || e.message);
    }
}
test();
