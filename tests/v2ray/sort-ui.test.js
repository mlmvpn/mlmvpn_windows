const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('public/components/v2ray.js','utf8');
const values=new Map();const nodes=[{uri:'slow',delay:200,ping:1},{uri:'fast',delay:40,ping:999},{uri:'untested'},{uri:'failed',delay:-1,delayNote:'timeout'}];
const radio={value:'0'};const context={window:{v2rayList:nodes,currentConnectedV2rayIndex:0,renderV2rayList(){},closeSortMenu(){}},document:{querySelector:()=>radio,querySelectorAll:()=>[],getElementById:()=>null},store:{get:(k,d)=>values.get(k)??d,set:(k,v)=>values.set(k,v)},SORT_KEY:'sort',updateBottomBarLead(){},saveV2rayList(){},toast(){}};
vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function markActiveSort()'),source.indexOf('// «کپی کانفیگ‌های سالم»')),context);
context.window.sortV2rayList();
assert.deepEqual(nodes.map(n=>n.uri),['fast','slow','untested','failed']);
assert.equal(nodes[context.window.currentConnectedV2rayIndex].uri,'slow','sorting must preserve live connection identity');
context.window.sortV2rayList();
assert.deepEqual(nodes.map(n=>n.uri),['slow','fast','untested','failed'],'second click sorts delay descending; unmeasured remain last');
console.log('PASS delay toggle and connected node identity');


