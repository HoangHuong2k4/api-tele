const axios = require('axios');
const crypto = require('crypto');

async function test() {
    const apiKey = '5by6bMpye7L9ByfcnyHnfaTgahw7UAoBNLh5uP1vj8dlsHtQVZRUabBqxqz6rInx';
    const secretKey = 'GpVPVFDppFRApQPjhCDBkwPk0a2Of0NOgh5RwiaxWV5SePvD8yyTB2Up7grPQ6m8';

    try {
        const { data: timeData } = await axios.get('https://api.binance.com/api/v3/time');
        const timestamp = timeData.serverTime;
        // Test with TRC20 and TRX
        const networks = ['TRC20', 'TRX', 'BSC'];
        for (const net of networks) {
            let qs = `coin=USDT&status=1&timestamp=${timestamp}&recvWindow=60000&network=${net}`;
            let sig = crypto.createHmac('sha256', secretKey).update(qs).digest('hex');
            
            try {
                await axios.get(`https://api.binance.com/sapi/v1/capital/deposit/hisrec?${qs}&signature=${sig}`, {
                    headers: { 'X-MBX-APIKEY': apiKey }
                });
                console.log("Success with network:", net);
            } catch (e) {
                console.log("Error with network:", net, e.response ? e.response.data : e.message);
            }
        }
    } catch (e) {
        console.log("Fatal Error:", e.message);
    }
}
test();
