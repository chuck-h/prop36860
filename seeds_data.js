#!/usr/bin/env node

const fs = require('fs')
const fetch = require('node-fetch');

const telosHost = 'telos.caleos.io';
const eosDfuseHost = 'eos.dfuse.eosnation.io';
const btcHost = 'blockchain.info';

const tlostoseedsPageSize = 20;
const seedsPerUSD = 10.3247;
const csvFileName = 'seeds_sale.csv';
const startDateTime = '2022-01-02T00:00:00';
const treasuryBtc = '3NYp8PuD6tEwKC1LEPAR2ebGvuYwifghEU';
const btcPageSize = 60;


async function tlostoseeds1Page(skip) {
  try {
    const url = `https://${telosHost}/v2/history/get_actions?limit=${tlostoseedsPageSize}&skip=${skip}`
                     +`&account=tlosto.seeds&track=true&sort=asc`
                     +`&after=${encodeURIComponent(startDateTime)}`;
    const res = await fetch(url);
    const response = await res.json();
    return response;
  } catch (error) {
    console.log(error);
    return error;
  }
};

var actions = [];
var seedsSendTotal = 0;
var seedsSendCount = 0;

async function tlostoseedsAll() {
  var skip = 0;
  while (true) {
    const r = await tlostoseeds1Page(skip);
    if (r.actions.length==0) {
      break;
    }
    skip += r.actions.length;
    const pageActions = r.actions.map( a => a.act.name=='newpayment' ? a : (
      a.act.name=='transfer'&&a.act.data.to=='tlosto.seeds'&&a.act.data.symbol=='HUSD' ?
         // HUSD as equivalent newpayment transaction
         {'act': {'data': { 'multipliedUsdValue': (a.act.data.amount*10000).toString(),
                            'paymentId': '',
                            'paymentSymbol': a.act.data.symbol,
                            'recipientAccount': a.act.data.from
                          }
                 },
          'timestamp': a.timestamp,
          'trx_id': a.trx_id
         }
         : null
      ));
    actions.push(...pageActions.filter(value => value != null));
    const seedsSendActions = r.actions.
      filter(a =>a.act.name=='transfer'&&a.act.data.from=='tlosto.seeds'&&a.act.data.symbol=='SEEDS');
    seedsSendTotal += seedsSendActions.reduce((sum, a) => { return sum + a.act.data.amount; }, 0);
    seedsSendCount += seedsSendActions.length;
  }
};

var btcReceipts = [];
const btcEarliest = new Date();

async function treasuryBtcReceipts() {
  try {
    const url = `https://${btcHost}/rawaddr/3NYp8PuD6tEwKC1LEPAR2ebGvuYwifghEU?limit=${btcPageSize}`;
    const res = await fetch(url);
    const response = await res.json();
    btcReceipts = response.txs.map( x => ({
      "tx_index": x.out[0].tx_index, "value": x.out[0].value, "hash": x.hash}));
    btcEarliest.setTime(response.txs[response.txs.length -1].time*1000);
  } catch (error) {
    console.log(error);
  }
};


var btcCount = 0;
var btcSum = 0;

async function btcTransaction(i) {
  try {
    const transactionId = payments[i].paymentId;
    const url = `https://${btcHost}/rawtx/${transactionId}`;
    const res = await fetch(url);
    const response = await res.json();
    const spentOuts = response.out.filter(tx => tx.spent);
    const matchedTx = btcReceipts.filter(value => 
      spentOuts.map(x => x.spending_outpoints[0].tx_index)
      .includes(value.tx_index))[0];
    payments[i] = {...payments[i], "btc_bank_tx":matchedTx.hash, "btc_sat_received":matchedTx.value};
    btcCount++;
    btcSum += matchedTx.value;
  } catch (error) {
    console.log(error);
  }
};

async function btcAll() {
  const promises = [];
  payments.forEach((payment, i) => {
    if (payment.paymentSymbol == 'BTC') {
      promises.push(btcTransaction(i));
    }
  });
  await Promise.all(promises);
}

var eosCount = 0;
var eosSum = 0;

async function eosTransaction(i) {
  try {
    const transactionId = payments[i].paymentId;
    const url = `https://${eosDfuseHost}/v0/transactions/${transactionId}`;
    const res = await fetch(url);
    const response = await res.json();
    const data = response.execution_trace.action_traces[0].act.data;
    const amount = parseFloat(data.quantity);
    payments[i] = {...payments[i], "eos_received":amount};
    eosCount++;
    eosSum += amount;
  } catch (error) {
    console.log(error);
  }
};

async function eosAll() {
  const promises = [];
  payments.forEach((payment, i) => {
    if (payment.paymentSymbol == 'EOS') {
      promises.push(eosTransaction(i));
    }
  });
  await Promise.all(promises);
};

var husdActions;
var husdSum;

function husdAll() {
  husdActions = actions.filter(a => a.act.data.paymentSymbol=='HUSD');
  husdSum = husdActions.reduce((sum, a) => {
      return sum + a.act.data.multipliedUsdValue/10000;
    }, 0);
  payments.forEach((payment, i) => {
    if (payment.paymentSymbol == 'HUSD') {
      payments[i] = {...payments[i], "husd_received":payment.multipliedUsdValue/10000 };
    }
  });
};


// main routine
(async() => {
  console.log(`seeds_data.js (https://dao.hypha.earth/hypha/proposals/36860) run started at \n   ${Date()}`);
  console.log(`Reading ${btcPageSize} most recent treasury BTC receipts for crossreference.`);
  await treasuryBtcReceipts();
  console.log(`... ${btcReceipts.length} transactions back to ${btcEarliest.toISOString()}.`);
  console.log(`Reading tlosto.seeds transactions since ${startDateTime}...`);
  await tlostoseedsAll();
  payments = actions.map( (a) => ({...a.act.data,
       'telosTx': a.trx_id,
       'timestamp': a.timestamp,
       'seedsQty': Math.trunc(a.act.data.multipliedUsdValue*seedsPerUSD)/10000}) );
  husdAll();
  console.log(`... ${husdActions.length} HUSD sales, total ${husdSum} HUSD.`);
  await btcAll();  
  console.log(`... ${btcCount} BTC sales, total = ${btcSum*1e-8} BTC`);
  await eosAll();
  console.log(`... ${eosCount} EOS sales, total = ${0.0001*Math.round(10000*eosSum)} EOS`);
  
  console.log(`... ${actions.length} tlosto.seeds income transactions processed,`);
  console.log(`...    summing to ${payments.reduce((sum, p) => { return sum + p.seedsQty; }, 0)} seeds,`+
        ` $${0.01*Math.trunc(payments.reduce((sum, p) => { return sum + +p.multipliedUsdValue; }, 0)/100)}.`);
  console.log(`... ${seedsSendCount} tlosto.seeds disbursement transactions processed.`);
  console.log(`...    ${0.0001*Math.round(10000*seedsSendTotal)} seeds disbursed` +
     ` = $${0.01*Math.trunc(100*seedsSendTotal/seedsPerUSD)} @ ${seedsPerUSD} seeds/USD.`);
  
  const replacer = (key, value) => value === null ? '' : value;
  const header = [...Object.keys(payments[0]).slice(0,7),
                  'btc_bank_tx', 'husd_received', 'btc_sat_received', 'eos_received'];
  const csv = [
    header.join(','), // header row first
    ...payments.map(row => header.map(fieldName => JSON.stringify(row[fieldName], replacer)).join(','))
  ].join('\r\n');

console.log(`Writing to ${csvFileName}.`);
fs.writeFileSync(csvFileName, csv);

})();
