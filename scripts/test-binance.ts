import axios from 'axios';
import * as crypto from 'crypto';

async function test() {
    const apiKey = 'YOUR_API_KEY';
    const secretKey = 'YOUR_SECRET_KEY';
    
    // Just to see what Binance returns when we use dummy keys
    try {
        const { data } = await axios.get('https://api.binance.com/api/v3/time');
        const timestamp = data.serverTime;
        let qs = `coin=USDT&status=1&timestamp=${timestamp}&recvWindow=60000`;
        qs += `&signature=${crypto.createHmac('sha256', secretKey).update(qs).digest('hex')}`;
        
        await axios.get(`https://api.binance.com/sapi/v1/capital/deposit/hisrec?${qs}`, {
            headers: { 'X-MBX-APIKEY': apiKey }
        });
    } catch (e: any) {
        console.log(e.response?.data || e.message);
    }
}
test();
