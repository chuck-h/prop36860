#!/usr/bin/env node

const fs = require('fs')
const fetch = require('node-fetch');

const telosHost = 'mainnet.telos.net';
const eosDfuseHost = 'eos.dfuse.eosnation.io';
const btcHost = 'blockchain.info';

const tlostoseedsPageSize = 100;
const seedsPerUSD = 10.3247;
const csvFileName = 'seeds_sale.csv';
const startDateTime = '2022-01-02T00:00:00';
const treasuryBtc = '3NYp8PuD6tEwKC1LEPAR2ebGvuYwifghEU';
const btcPageSize = 2000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

var seedsPriceHistory = [];

async function loadSeedsPrices() {
  var more;
  var lower_bound = '';
  do {
  try {
    const url = `https://${telosHost}/v1/chain/get_table_rows`;
    const data = {
      code: 'tlosto.seeds',
      table: 'pricehistory',
      scope: 'tlosto.seeds',
      lower_bound: lower_bound,
      limit: 100,
      json: true
    };
    const res = await fetch(url, {
      method: 'POST',
      body: JSON.stringify(data),
      headers: { 'Content-Type': 'application/json',
                 'accept': 'application/json'
      }
      });
    const result = await res.json();
    seedsPriceHistory.push(...result.rows);
    more = result.more;
    lower_bound = result.next_key;
  } catch (error) {
    console.log(error);
    more = false;
  }
  } while (more);
};

function priceAtDate(timestamp) {
  const i = seedsPriceHistory.findIndex( r => r.date > timestamp );
  var j = i-1;
  if (i < 0) {
    j = seedsPriceHistory.length-1;
  }
  if (i == 0) {
    j = 0;
  }
  return seedsPriceHistory[j].seeds_usd.split(" ")[0];
};

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

var seedsActionCount = 0;
var actions = [];
var seedsSendActions= [];
var seedsSendTotal = 0;
var seedsSendIndex = new Map();
var seedsRcvTotal = 0;
var seedsRcvCount = 0;

async function tlostoseedsAll() {
  while (true) {
    const r = await tlostoseeds1Page(seedsActionCount);
    if (r.actions.length==0) {
      break;
    }
    seedsActionCount += r.actions.length;
    const pageActions = r.actions.map( a => a.act.name=='newpayment' ? a : (
      a.act.name=='transfer'&&a.act.data.to=='tlosto.seeds' ?
        (a.act.data.symbol=='HUSD' ?
          // HUSD as equivalent newpayment transaction
          {'act': {'data': { 'multipliedUsdValue': (a.act.data.amount*10000).toString(),
                             'paymentId': '',
                             'paymentSymbol': a.act.data.symbol,
                             'recipientAccount': a.act.data.from
                           }
                  },
           'timestamp': a.timestamp,
           'trx_id': a.trx_id
          } : (a.act.data.symbol=='TLOS' ?
            // TELOS as equivalent newpayment transaction (no TLOS price yet)
            {'act': {'data': { 'multipliedUsdValue': 0,
                               'paymentId': '',
                               'paymentSymbol': a.act.data.symbol,
                               'recipientAccount': a.act.data.from,
                               'x_amount': a.act.data.amount
                             }
                    },
             'timestamp': a.timestamp,
             'trx_id': a.trx_id
            } : null
          ) 
        ) : null
      ));
    actions.push(...pageActions.filter(value => value != null));
    const seedsSends = r.actions.
      filter(a =>a.act.name=='transfer'&&a.act.data.from=='tlosto.seeds'&&a.act.data.symbol=='SEEDS');
    seedsSendTotal += seedsSends.reduce((sum, a) => { return sum + a.act.data.amount; }, 0);
    seedsSendActions.push(...seedsSends);
    const seedsRcvActions = r.actions.
      filter(a =>a.act.name=='transfer'&&a.act.data.to=='tlosto.seeds'&&a.act.data.symbol=='SEEDS');
    seedsRcvTotal += seedsRcvActions.reduce((sum, a) => { return sum + a.act.data.amount; }, 0);
    seedsRcvCount += seedsRcvActions.length;
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
var btcUnmatchedCount = 0;
var btcUnmatchedSeeds = 0;

var badJsons = [];

async function btcTransaction(i) {
  var res;
  var body;
  var transactionId;
  try {
    transactionId = payments[i].paymentId;
    const url = `https://${btcHost}/rawtx/${transactionId.split(" ")[0]}`;
    res = await fetch(url);
    body = await res.text();
    var response;
    try {
      response = JSON.parse(body);
    } catch(err) {
      badJsons.push(i);
      console.log(`bad Json at payment ${i}`);
      return;
    }
    const spentOuts = response.out.filter(tx => tx.spent);
    const matchedTx = btcReceipts.filter(value => 
      spentOuts.map(x => x.spending_outpoints[0].tx_index)
      .includes(value.tx_index))[0];
    if (matchedTx === undefined) {
      btcUnmatchedCount++;
      btcUnmatchedSeeds += payments[i].seedsQty;
      payments[i] = {...payments[i], "btc_out_count":spentOuts.length};
    } else {
      btcSum += matchedTx.value;
      payments[i] = {...payments[i], "btc_bank_tx":matchedTx.hash, "btc_sat_received":matchedTx.value, "btc_out_count":spentOuts.length};
    }
    btcCount++;
  } catch (error) {
    console.log(`failed txId ${transactionId}`);
    //console.log(`fetch response: ${body}`);
    //console.log(error);
  }
};

async function btcAll() {
  const promises = [];
  payments.forEach((payment, i) => {
    if (payment.paymentSymbol.toUpperCase() == 'BTC') {
      promises.push(btcTransaction(i));
    }
  });
  await Promise.all(promises);
}

async function btcRetry() {
  const promises = [];
  for (i in badJsons) {
    promises.push(btcTransaction(badJsons[i]));
  }
  badJsons = [];
  await Promise.all(promises);
}


var eosCount = 0;
var eosSum = 0;

async function eosTransaction(i) {
  try {
    const transactionId = payments[i].paymentId;
    const url = `https://${eosDfuseHost}/v0/transactions/${transactionId}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`fetch EOS tx ${transactionId} failure`);
    }
    const response = await res.json();
    var xfr = response.execution_trace.action_traces.find(
      a => a.act.name=='transfer'&&a.act.data.quantity.split(" ")[1]==='EOS');
    if (xfr === undefined) {
      const inlines = response.execution_trace.action_traces.filter(a => a.inline_traces.length>0);
      const ixfr = inlines.find(a => a.inline_traces.find(
        t => t.act.name=='transfer'&&t.act.data.quantity.split(" ")[1]==='EOS') != undefined);
      if (ixfr === undefined) {
        console.log(`${JSON.stringify(response)}`);
      }
      xfr = ixfr.inline_traces[0];
    }
    const data = xfr.act.data;
    const amount = parseFloat(data.quantity);
    payments[i] = {...payments[i], "eos_received":amount};
    eosSum += amount;
  } catch (error) {
    console.log(`telos ${payments[i].telosTx} ${payments[i].timestamp}\n  eos ${payments[i].paymentId}`);
    console.log(error);
  }
};

async function eosAll() {
  const promises = [];
  payments.forEach((payment, i) => {
    if (payment.paymentSymbol.toUpperCase() == 'EOS') {
      promises.push(eosTransaction(i));
      eosCount++;
    }
  });
  await Promise.all(promises);
};

var husdActions = [];
var husdSum = 0;

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

var telosActions = [];
var telosSum = 0;
var telosUsdSum = 0;

function telosAll() {
  telosActions = actions.filter(a => a.act.data.paymentSymbol=='TLOS');
  telosSum = telosActions.reduce((sum, a) => {
      return sum + a.act.data.x_amount;
    }, 0);
  payments.forEach((payment, i) => {
    if (payment.paymentSymbol == 'TLOS') {
      payments[i] = {...payments[i], "telos_received":payment.x_amount };
      const usdValue = payments[i].seedsQty/priceAtDate(payments[i].timestamp);
      telosUsdSum += usdValue;
      payments[i].usdValue = usdValue;     
      payments[i].multipliedUsdValue = 10000.*usdValue;
    }
  });
};

var usdActions = [];
var usdSum = 0;

function usdAll() {
  usdActions = actions.filter(a => a.act.data.paymentSymbol=='usd');
  usdSum = usdActions.reduce((sum, a) => {
      return sum + a.act.data.multipliedUsdValue/10000;
    }, 0);
};

// main routine
(async() => {
  console.log(`seeds_data.js (https://dao.hypha.earth/hypha/proposals/36860) run started at \n   ${Date()}`);
  console.log(`Reading ${btcPageSize} most recent treasury BTC receipts for crossreference.`);
  await treasuryBtcReceipts();
  console.log(`... ${btcReceipts.length} transactions back to ${btcEarliest.toISOString()}.`);
  console.log(`Reading seeds price history table`);
  await loadSeedsPrices();
  console.log(`... ${seedsPriceHistory.length} price entries.`);
  console.log(`Reading tlosto.seeds transactions since ${startDateTime}...`);
  await tlostoseedsAll();
  console.log(`... ${seedsActionCount} total actions.`);
  seedsSendActions.forEach((ssa, i) => {
    seedsSendIndex.set(ssa.trx_id, i);
  });
  payments = actions.map( (a) => ({...a.act.data,
       'usdValue': 0.0001*a.act.data.multipliedUsdValue,
       'telosTx': a.trx_id,
       'timestamp': a.timestamp,
       'seedsQty': seedsSendIndex.has(a.trx_id) ?
                     seedsSendActions[seedsSendIndex.get(a.trx_id)].act.data.amount : 0,
       'seedsValue': (seedsSendIndex.has(a.trx_id) ?
                       seedsSendActions[seedsSendIndex.get(a.trx_id)].act.data.amount : 0)/
                     priceAtDate(a.timestamp)
        })  
      );           
  husdAll();
  console.log(`... ${husdActions.length} HUSD sales, total ${husdSum.toFixed(2)} HUSD.`);
  telosAll();
  console.log(`... ${telosActions.length} TLOS sales, total ${telosSum.toFixed(4)} TLOS` +
                      ` = $${telosUsdSum.toFixed(2)}`);
  usdAll();
  console.log(`... ${usdActions.length} "usd" sales, total $${usdSum.toFixed(2)}`);
  await btcAll();  
  console.log(`    BTC badJsons: ${JSON.stringify(badJsons)} to retry`);
  await btcRetry();
  console.log(`... ${btcCount} BTC sales, total = ${btcSum*1e-8} BTC to treasury`);
  console.log(`...    includes ${btcUnmatchedCount} BTC sales (${
                  btcUnmatchedSeeds.toFixed(4)} SEEDS) not matched to treasury`);
  if (badJsons.length > 0) {
    console.log(`... ${badJsons.length} BTC transactions couldn't be retrieved from chain.`);
  }
  await eosAll();
  console.log(`... ${eosCount} EOS sales, total = ${eosSum.toFixed(4)} EOS`);
  
  console.log(`... ${actions.length} tlosto.seeds income transactions processed,`);
  console.log(`...    summing to ${
                payments.reduce((sum, p) => { return sum + p.seedsQty; }, 0).toFixed(4)
                } seeds, $${
                (payments.reduce((sum, p) => { return sum + +p.multipliedUsdValue; }, 0)/10000).toFixed(2)
                }.`);
  console.log(`... ${seedsSendActions.length} tlosto.seeds disbursement transactions processed.`);
  console.log(`...    ${seedsSendTotal.toFixed(4)} seeds disbursed` );
  console.log(`... ${seedsRcvCount} raw SEEDS transfers into tlosto.seeds .`);
  console.log(`...    ${seedsRcvTotal.toFixed(4)} seeds transfered in.`);
  console.log(`... ${(seedsRcvTotal-seedsSendTotal).toFixed(4)} seeds net change.`);
  
  const replacer = (key, value) => value === null ? '' : value;
  const header = [//...Object.keys(payments[0]).slice(0,8),
                  'recipientAccount', 'paymentSymbol', 'paymentId', 'multipliedUsdValue',
                  'usdValue', 'seedsValue', 'telosTx', 'timestamp', 'seedsQty',
                  'btc_out_count', 'btc_bank_tx', 'husd_received', 'btc_sat_received',
                  'eos_received', 'telos_received'];
  const csv = [
    header.join(','), // header row first
    ...payments.map(row => header.map(fieldName => JSON.stringify(row[fieldName], replacer)).join(','))
  ].join('\r\n');

console.log(`Writing to ${csvFileName}.`);
fs.writeFileSync(csvFileName, csv);

})();
