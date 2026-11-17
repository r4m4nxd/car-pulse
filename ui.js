"use strict";
const $=s=>document.querySelector(s);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const fx=(v,d=0)=>v==null||!isFinite(v)?"–":v.toFixed(d);
const hms=s=>{s=Math.round(s);const h=Math.floor(s/3600),m=Math.floor(s%3600/60);return h?`${h}h ${String(m).padStart(2,"0")}m`:`${m}:${String(s%60).padStart(2,"0")}`};
const when=ts=>new Date(ts).toLocaleString([], {month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
const money=v=>v==null||!isFinite(v)?"–":"$"+v.toFixed(2);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let logText="";logSink=s=>{logText=(logText+s+"\n").slice(-20000);const p=$("#logPre");if(p){p.textContent=logText;p.scrollTop=p.scrollHeight}};

let hold=false,sheetCleanup=null,link=null,caps=null,running=false,trip=null,live={},wake=null,trips=[],fills=[],model=buildModel([],[]),coast=null,ecu={};
const K=()=>model.k||1;
const curCents=()=>{const l=model.fillStats.last;if(l)return l.cents;const c=JSON.parse(localStorage.getItem("cp-prices")||"null");if(!c)return null;const m=Object.keys(c.o).sort().pop();return m?c.o[m]:null};

/* ---------- live session ---------- */
async function readKeys(keys){
  if(!keys.length)return;
  if(caps.batch){for(let i=0;i<keys.length;i+=6){const r=parse01(await link.cmd("01"+keys.slice(i,i+6).map(k=>P[k][0]).join(""),1500));
      if(Object.keys(r).length){Object.assign(live,r);caps.miss=0}else if(++caps.miss>6){caps.batch=false;log("Multi-request stopped answering; using single requests")}}}
  else for(const k of keys){if(!running&&!link)return;Object.assign(live,parse01(await link.cmd("01"+P[k][0]+caps.one,1500)))}}
async function start(kind){
  if(link)return;
  if(kind==="ble"&&!navigator.bluetooth)return showConnectHelp();
  const L=kind==="demo"?new DemoLink():new BleLink();
  setPill("","Connecting…");$("#bConnect").disabled=true;
  try{await L.open();caps=await initLink(L);caps.miss=0;link=L;L.onclose=()=>stop(true)}
  catch(e){log("Connect failed: "+e.message);try{L.close()}catch(_){}link=null;setPill("","Not connected");$("#bConnect").disabled=false;if(e.name!=="NotFoundError")alert(e.message||"Could not connect to the scanner.");return}
  running=true;live={};trip=new Trip(Date.now(),kind==="demo"?"demo":"live");
  setPill(kind==="demo"?"demo":"live",kind==="demo"?"Demo drive":(L.dev&&L.dev.name)||"Connected");
  $("#connectBox").style.display="none";$("#bEnd").style.display="";$("#bConnect").disabled=false;
  try{wake=await navigator.wakeLock.request("screen")}catch(e){}
  loop();renderLab();
}
async function loop(){
  const t0=performance.now(),t1=TIER1.filter(k=>caps.keys.includes(k)),t2=caps.keys.filter(k=>!t1.includes(k)),g=caps.batch?6:1;let i=0,n=0,hzT=t0,myTrip=trip;
  while(running&&link&&trip===myTrip){
    if(hold){await sleep(150);continue}
    await readKeys(t1);
    if(t2.length){await readKeys(t2.slice(i,i+g));i=i+g>=t2.length?0:i+g}
    if(!caps.keys.includes("volt")&&n%10===0){const v=parseFloat(await link.cmd("ATRV",1500));if(isFinite(v))live.volt=v}
    if(!running||!link)return;
    live.lph=live.rpm>300?lphRaw(live):live.rpm!=null?0:null;
    const t=(performance.now()-t0)/1000*(link.rate||1);trip.add(t,live);
    if(coast&&coast.on)coast.pts.push([t,live.speed??0]);
    if(++n%10===0){const now=performance.now();live.hz=10000/(now-hzT);hzT=now}
    renderDrive();if(link.demo)await sleep(110)}}
async function stop(lost){
  if(!link&&!running)return;running=false;const L=link;link=null;
  try{wake&&wake.release()}catch(e){}wake=null;
  if(!lost)try{L&&L.close()}catch(e){}
  await saveTrip();trip=null;live={};caps=null;setPill("","Not connected");$("#connectBox").style.display="flex";$("#bEnd").style.display="none";renderDrive();renderLab()}
async function saveTrip(){if(!trip||!(trip.dist>0.2||trip.dur>60))return;const t=trip;await Trips.put(t.data());await Raw.put(t.raw());
  const raws=(await Raw.all()).sort((a,b)=>b.id-a.id);for(const r of raws.slice(40))await Raw.del(r.id);await refresh()}
addEventListener("pagehide",()=>{if(trip&&(trip.dist>0.2||trip.dur>60)){Trips.put(trip.data());Raw.put(trip.raw())}});
function setPill(cls,txt){const p=$("#pill");p.className="pill "+cls;p.lastElementChild.textContent=txt}
$("#pill").onclick=()=>{if(!link)start("ble")};
function showConnectHelp(){openSheet(`<h2>Connecting on iPhone</h2>
<p class="note" style="font-size:15px;color:var(--soft)">iPhone browsers (Safari and Chrome) are not allowed to talk to Bluetooth devices. The free <b>Bluefy</b> browser from the App Store can.</p>
<div class="rows"><div class="row"><span>1. Install Bluefy – Web BLE Browser</span></div><div class="row"><span>2. Open this page inside Bluefy and bookmark it</span></div><div class="row"><span>3. Close other scanner apps, ignition on, tap Connect scanner, pick VEEPEAK</span></div></div>
<p class="note">Trips are stored per browser, so keep using the app inside Bluefy.</p><p class="note" style="word-break:break-all">${esc(location.href)}</p>`)}

/* ---------- drive ---------- */
function bestBand(){let b=-1,v=1e9;model.bands.forEach((x,i)=>{if(x[0]>5&&x[1]>0){const l=x[1]/x[0];if(l<v){v=l;b=i}}});return b}
function renderDrive(){
  const d=live,on=!!link;$("#vSpeed").textContent=fx(d.speed);$("#gSpeed").setAttribute("stroke-dasharray",Math.min(1,(d.speed||0)/180)*477.5+" 478");
  $("#vRpm").innerHTML=(d.rpm==null?"–":(Math.round(d.rpm/10)*10).toLocaleString())+" <span>rpm</span>";$("#bRpm").style.width=Math.min(100,(d.rpm||0)/7000*100)+"%";$("#bRpm").style.background=d.rpm>6000?"var(--red)":"var(--blue)";
  const lph=d.lphEff??d.lph,mov=d.speed>5&&lph!=null,now=lph==null?null:mov?Math.min(99,lph*K()/d.speed*100):lph*K();
  $("#lNow").textContent=mov||!on?"Using now":"Idling";$("#vNow").innerHTML=fx(now,1)+` <span>${mov||!on?"L/100 km":"L/h"}</span>`;$("#bNow").style.width=(now==null?0:Math.min(100,now/(mov?20:3)*100))+"%";
  const avg=trip&&trip.avg?trip.avg*K():null,ref=avg||model.avg;$("#vAvg").textContent=fx(avg,1);
  $("#vRange").textContent=d.fuel!=null&&ref?Math.round(d.fuel/100*S.tank/ref*100/10)*10:"–";
  const c=curCents();$("#vCost").textContent=trip&&c?money(trip.fuel*K()*c/100):"–";
  $("#vKw").textContent=fx(d.kw);$("#vLoad").textContent=fx(d.load);$("#vTim").textContent=fx(d.timing,1);
  $("#rTrip").textContent=trip?`${fx(trip.dist,1)} km · ${hms(trip.dur)}`:"–";
  $("#rCool").textContent=d.coolant==null?"–":`${fx(d.coolant)} °C · ${d.coolant>108?"hot":d.coolant<70?"warming up":"normal"}`;
  $("#rVolt").textContent=d.volt==null?"–":`${fx(d.volt,1)} V · ${d.rpm>300?(d.volt<13.2?"low charge":"charging"):"engine off"}`;
  $("#rFuel").textContent=d.fuel==null?"–":`${fx(d.fuel)} % · ${fx(d.fuel/100*S.tank)} L`;
  $("#rHz").textContent=on&&caps?`${fx(d.hz,1)} Hz · ${caps.keys.length} sensors`:"–";
  const bb=bestBand();$("#tip").textContent=!on?"Connect the scanner to start.":d.coolant!=null&&d.coolant<60?"Engine is cold: fuel use is higher until it warms up.":d.lphEff===0&&d.speed>15?"Fuel cut: coasting in gear is using no fuel.":bb>=0&&d.speed>=BANDS[bb][0]&&d.speed<BANDS[bb][1]?"You are in your most efficient speed band.":d.speed<1&&trip&&trip.idle>120?`Idling has used ${fx(trip.idleFuel*K(),2)} L this trip.`:`Reading ${caps?caps.keys.length:0} sensors${caps&&caps.batch?" in fast mode":""}.`}

/* ---------- insights ---------- */
async function refresh(){trips=(await Trips.all()).sort((a,b)=>b.start-a.start);fills=await Fills.all();model=buildModel(trips,fills);renderInsights();renderFuel();renderTrends();renderDrive()}
function renderInsights(){
  const has=trips.length>0;$("#iEmpty").style.display=has?"none":"";$("#iBody").style.display=has?"flex":"none";if(!has){$("#iSub").textContent="Nothing learned yet";return}
  const m=model,real=trips.filter(t=>t.src!=="demo"),use=real.length?real:trips;$("#iSub").textContent=`Learned from ${use.length} trip${use.length>1?"s":""} · ${fx(m.dist,m.dist<100?1:0)} km${real.length?"":" (demo data)"}`;
  const sc=Math.round(use.reduce((a,t)=>a+t.score*Math.max(t.dist,.1),0)/use.reduce((a,t)=>a+Math.max(t.dist,.1),0)),br=use.reduce((a,t)=>a+t.brakes,0),ac=use.reduce((a,t)=>a+t.accels,0),idleP=m.dur?m.idle/m.dur*100:0;
  $("#vScore").textContent=sc;$("#gScore").setAttribute("stroke-dasharray",sc/100*295+" 295");$("#gScore").setAttribute("stroke",sc>=75?"#30d158":sc>=50?"#ff9f0a":"#ff453a");
  $("#scoreT").textContent=sc>=85?"Smooth driver":sc>=65?"Fairly smooth":"Room to smooth out";$("#scoreD").textContent=`${br} hard brake${br===1?"":"s"}, ${ac} hard start${ac===1?"":"s"}; idling is ${fx(idleP)} % of drive time.`;
  const al=$("#alertCard");al.style.display=m.alerts.length?"":"none";al.innerHTML=`<span class="cap" style="color:var(--orange)">Out of the ordinary</span>`+m.alerts.map(a=>`<span style="font-size:14px;color:var(--soft)">${esc(a)}</span>`).join("");
  $("#vReal").textContent=fx(m.avg,1);$("#calTag").textContent=m.kN?`Calibrated by ${m.kN} fill-up${m.kN>1?"s":""}`:"Sensor estimate";$("#calTag").style.color=m.kN?"var(--green)":"var(--sub)";
  $("#calNote").textContent=m.kN?`Sensors read ${fx(Math.abs(m.k-1)*100)} % ${m.k>1?"low":"high"} for this car, so every figure in the app is corrected.`:"Save two full-tank fill-ups in a row and the app corrects this against what really went into the tank.";
  const bv=m.bands.map(b=>b[0]>0.5&&b[1]>0?b[1]*K()/b[0]*100:null),mx=Math.max(...bv.filter(x=>x),1),bb=bestBand();
  $("#bandBars").style.gridTemplateColumns=$("#bandAxis").style.gridTemplateColumns=`repeat(${BANDS.length},minmax(0,1fr))`;
  $("#bandBars").innerHTML=bv.map((v,i)=>`<div class="${i===bb?"best":""}"><span>${fx(v,1)}</span><i style="height:${v?Math.max(6,v/mx*74):0}px"></i></div>`).join("");
  $("#bandAxis").innerHTML=BANDS.map(b=>`<span>${b[1]>900?b[0]+"+":b[0]+"–"+b[1]}</span>`).join("");
  const eF=use.reduce((a,t)=>a+t.fuel,0)*K()*E_FUEL,parts=[["Aero drag",use.reduce((a,t)=>a+(t.eAero||0),0),"#0a84ff"],["Rolling",use.reduce((a,t)=>a+(t.eRoll||0),0),"#30d158"],["Braking",use.reduce((a,t)=>a+(t.eBrake||0),0),"#ff9f0a"],["Idling",use.reduce((a,t)=>a+(t.idleFuel||0),0)*K()*E_FUEL,"#bf5af2"]];
  const used=parts.reduce((a,p)=>a+p[1],0);parts.push(["Engine and driveline heat",Math.max(0,eF-used),"#48484a"]);const tot=Math.max(eF,used,1);
  $("#eStack").innerHTML=parts.map(p=>`<i style="width:${p[1]/tot*100}%;background:${p[2]}"></i>`).join("");$("#eLegend").innerHTML=parts.map(p=>`<span><i style="background:${p[2]}"></i>${p[0]} ${fx(p[1]/tot*100)} %</span>`).join("");
  const wm=m.warm.length?median(m.warm.map(w=>w.s)):null,rows=[];
  if(wm!=null)rows.push(["Warm-up to 80 °C",`${fx(wm/60,1)} min from ${fx(median(m.warm.map(w=>w.start)))} °C`]);
  for(const k in m.norm){const n=m.norm[k];rows.push([n.label,`${fx(n.lo,n.dp)} to ${fx(n.hi,n.dp)} ${n.unit}`])}
  rows.push(["Fuel cut on overrun",m.dur?fx(m.dfco/m.dur*100,1)+" % of drive time":"–"],["CO₂ emitted",fx(m.fuel*K()*CO2,1)+" kg"]);
  const c=curCents();if(c&&m.avg)rows.push(["Fuel cost per km",fx(c*m.avg/100,1)+" ¢"]);
  $("#normRows").innerHTML=rows.map(r=>`<div class="row"><span>${r[0]}</span><span>${r[1]}</span></div>`).join("");
  $("#tripList").innerHTML=trips.map(t=>`<div class="row tap" data-id="${t.id}"><div>${when(t.start)}<small>${fx(t.dist,1)} km · ${hms(t.dur)}${t.src==="demo"?" · demo":""}</small></div><span>${t.avg?fx(t.avg*K(),1)+" L/100":"–"}</span></div>`).join("")}
$("#tripList").onclick=e=>{const r=e.target.closest(".row");if(r)showTrip(trips.find(t=>t.id==r.dataset.id))};
function showTrip(t){
  const k=(n,v,u="")=>`<div class="kpi"><small>${n}</small><b>${v}</b><span>${u}</span></div>`,c=curCents(),f=t.fuel*K();
  openSheet(`<div><h2>${when(t.start)}</h2><span class="sub">${t.src==="demo"?"Demo drive":"Recorded live"}</span></div>
  <div class="k3">${k("Distance",fx(t.dist,1),"km")}${k("Time",hms(t.dur))}${k("Average",t.avg?fx(t.avg*K(),1):"–","L/100 km")}</div>
  <div class="k3">${k("Fuel",fx(f,2),"litres")}${k("Cost",c?money(f*c/100):"–")}${k("CO₂",fx(f*CO2,1),"kg")}</div>
  <div class="k3">${k("Avg speed",fx(t.dur?t.dist/(t.dur/3600):null),"km/h")}${k("Top speed",fx(t.maxV),"km/h")}${k("Peak rpm",fx(t.maxR))}</div>
  <div class="k3">${k("Hard brakes",t.brakes)}${k("Hard starts",t.accels)}${k("Score",t.score,"/100")}</div>
  <div class="k3">${k("Idle",hms(t.idle),fx(t.idleFuel*K(),2)+" L")}${k("Fuel cut",hms(t.dfco||0))}${k("Peak temp",fx(t.maxC),"°C")}</div>
  ${[["Speed · km/h","v","#30d158"],["Engine speed · rpm","r","#0a84ff"],["Power at crank · kW (estimated)","p","#bf5af2"],["Fuel flow · L/h","f","#ff9f0a"],["Coolant · °C","c","#ff453a"]].map(([n,key],i)=>`<div class="card"><span class="cap">${n}</span><canvas id="tc${i}"></canvas></div>`).join("")}
  <button class="btn" id="bCsv">Export full sensor log (CSV)</button><button class="btn danger" id="bDel">Delete this trip</button>`);
  [["v","#30d158"],["r","#0a84ff"],["p","#bf5af2"],["f","#ff9f0a"],["c","#ff453a"]].forEach(([key,col],i)=>chart($("#tc"+i),t.s.t,t.s[key]||[],col,hms));
  $("#bDel").onclick=async()=>{if(confirm("Delete this trip?")){await Trips.del(t.id);await Raw.del(t.id);closeSheet();refresh()}};
  $("#bCsv").onclick=async()=>{const r=await Raw.get(t.id);if(!r||!r.rows.length)return alert("The full log for this trip is no longer stored (only the latest 40 trips keep one).");
    saveFile("car-pulse-"+new Date(t.start).toISOString().slice(0,16).replace(/[:T]/g,"-")+".csv",r.keys.map(x=>x==="t"?"time_s":x).join(",")+"\n"+r.rows.map(row=>r.keys.map((_,i)=>row[i]??"").join(",")).join("\n"),"text/csv")}}
function chart(cv,xs,ys,color,xf=x=>fx(x)){
  const dpr=devicePixelRatio||1,w=cv.clientWidth,h=cv.clientHeight;cv.width=w*dpr;cv.height=h*dpr;const g=cv.getContext("2d");g.scale(dpr,dpr);
  const pts=xs.map((x,i)=>[x,ys[i]]).filter(p=>p[1]!=null&&isFinite(p[1]));g.font="11px -apple-system,sans-serif";g.fillStyle="#98989f";
  if(pts.length<2){g.textAlign="center";g.fillText("No data yet",w/2,h/2);return}
  let mn=Infinity,mx=-Infinity;for(const p of pts){if(p[1]<mn)mn=p[1];if(p[1]>mx)mx=p[1]}if(mx-mn<1e-6){mx+=1;mn-=1}
  const x0=pts[0][0],x1=pts[pts.length-1][0],pad=18,X=x=>(x-x0)/(x1-x0||1)*w,Y=y=>pad+(1-(y-mn)/(mx-mn))*(h-18-pad);
  g.beginPath();pts.forEach((p,i)=>i?g.lineTo(X(p[0]),Y(p[1])):g.moveTo(X(p[0]),Y(p[1])));g.strokeStyle=color;g.lineWidth=2;g.lineJoin="round";g.stroke();
  g.lineTo(w,h-18);g.lineTo(0,h-18);g.closePath();const gr=g.createLinearGradient(0,0,0,h);gr.addColorStop(0,color+"44");gr.addColorStop(1,color+"00");g.fillStyle=gr;g.fill();
  const d=mx-mn<20?1:0;g.fillStyle="#98989f";g.textAlign="left";g.fillText("max "+fx(mx,d),2,11);g.fillText(xf(x0),2,h-3);g.textAlign="right";g.fillText("min "+fx(mn,d),w-2,11);g.fillText(xf(x1),w-2,h-3)}
function saveFile(name,text,type){const blob=new Blob([text],{type});
  (async()=>{try{const file=new File([blob],name,{type});if(navigator.canShare&&navigator.canShare({files:[file]})){await navigator.share({files:[file]});return}}catch(e){if(e.name==="AbortError")return}
    const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=name;a.click()})()}

/* ---------- fuel ---------- */
const num=s=>{const v=parseFloat(String(s).replace(",","."));return isFinite(v)?v:null};
const today=()=>{const d=new Date();return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")};
let priceSrc="manual";
async function fillPrice(){const p=await priceFor($("#fDate").value||today());if(!p){$("#fNote").textContent="Could not reach the price service. Type the price or the total you paid.";return}
  const mn=new Date(p.month+"-15").toLocaleString([], {month:"long",year:"numeric"});$("#fP").value=p.cents.toFixed(1);priceSrc="statcan";calcTotal();
  $("#fNote").textContent=`${GEO[S.geo]} average for ${mn} (Statistics Canada, regular self-serve)${p.exact?"":"; this month's figure is not published yet"}. Change it, or type the total you paid.`}
const calcTotal=()=>{const l=num($("#fL").value),p=num($("#fP").value);if(l&&p)$("#fT").value=(l*p/100).toFixed(2)};
$("#fL").oninput=calcTotal;$("#fP").oninput=()=>{priceSrc="manual";calcTotal()};
$("#fT").oninput=()=>{const l=num($("#fL").value),t=num($("#fT").value);if(l&&t){$("#fP").value=(t/l*100).toFixed(1);priceSrc="manual"}};
$("#fDate").onchange=fillPrice;
$("#bFill").onclick=async()=>{const l=num($("#fL").value),p=num($("#fP").value),d=$("#fDate").value||today();if(!l||l<=0||l>150)return alert("Enter the litres you added.");if(!p)return alert("Enter the price per litre or the total you paid.");
  const ts=d===today()?Date.now():new Date(d+"T12:00").getTime();await Fills.put({id:ts,ts,litres:l,cents:p,odo:num($("#fO").value),full:$("#fFull").value==="1",src:priceSrc});
  $("#fL").value=$("#fT").value=$("#fO").value="";await refresh();fillPrice()};
function renderFuel(){
  const fs=[...model.fillStats.fills].reverse(),now=new Date(),mo=fs.filter(f=>{const d=new Date(f.ts);return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear()});
  $("#fuMonth").textContent=mo.length?"$"+fx(mo.reduce((a,f)=>a+f.litres*f.cents/100,0)):"–";$("#fuMonthL").textContent=mo.length?fx(mo.reduce((a,f)=>a+f.litres,0))+" litres":"no fill-ups";
  const c=curCents();$("#fuKm").textContent=c&&model.avg?fx(c*model.avg/100,1)+"¢":"–";
  // litres left: live gauge if connected, else tank minus fuel used since the last full fill
  const last=fs.find(f=>f.full),real=trips.filter(t=>t.src!=="demo");let left=live.fuel!=null?live.fuel/100*S.tank:last?S.tank-real.filter(t=>t.start>last.ts).reduce((a,t)=>a+t.fuel,0)*K():null;
  const recent=real.filter(t=>t.start>Date.now()-14*864e5),daily=recent.reduce((a,t)=>a+t.fuel,0)*K()/14;
  $("#fuNext").textContent=left!=null&&daily>0.05?Math.max(0,Math.round((left-6)/daily))+" days":"–";
  if(!$("#fO").value){const o=live.odo??(real[0]&&real[0].odo1);if(o)$("#fO").placeholder=fx(o)}
  $("#fillList").innerHTML=fs.length?fs.map(f=>`<div class="row tap" data-id="${f.id}"><div>${new Date(f.ts).toLocaleDateString([], {month:"short",day:"numeric"})} · ${fx(f.litres,1)} L${f.full?"":" (partial)"}<small>${fx(f.cents,1)} ¢/L${f.real?` · ${fx(f.real,1)} L/100 km measured`:""}</small></div><span>${money(f.litres*f.cents/100)}</span></div>`).join(""):`<div class="empty">No fill-ups saved yet.</div>`}
$("#fillList").onclick=async e=>{const r=e.target.closest(".row");if(r&&confirm("Delete this fill-up?")){await Fills.del(+r.dataset.id);refresh()}};

/* ---------- health ---------- */
const chip=(s,t)=>`<span class="chip ${s}">${t}</span>`;
async function health(){
  if(!link)return alert("Connect the scanner first (Drive tab).");
  $("#bHealth").disabled=true;$("#verT").textContent="Checking…";$("#verD").textContent="Reading the engine computer.";
  try{
    const rd=parseReadiness(await link.cmd("0101")),stored=parseDtcs(await link.cmd("03",6000),3,caps.isCan),pending=parseDtcs(await link.cmd("07",6000),7,caps.isCan),perm=parseDtcs(await link.cmd("0A",6000),0x0A,caps.isCan);
    const rv=parseFloat(await link.cmd("ATRV"));const v=live.volt??(isFinite(rv)?rv:null),on=live.rpm>300,n=model.norm,rows=[];let warn=0,bad=0;
    const add=(name,detail,state,label)=>{rows.push(`<div class="row"><div>${name}<small>${detail}</small></div>${chip(state,label)}</div>`);if(state==="warn")warn++;if(state==="bad")bad++};
    add("Check-engine light",rd?(rd.mil?"On":"Off")+` · ${rd.count} code${rd.count===1?"":"s"} flagged`:"No answer",!rd?"na":rd.mil?"bad":"",!rd?"Unknown":rd.mil?"Fault":"OK");
    const vs=v==null?"na":on?(v<13.2||v>14.9?"warn":""):(v<12.2?"warn":"");add(on?"Charging":"Battery at rest",v==null?"No reading":`${fx(v,2)} V · engine ${on?"running":"off"}${n[on?"chargeV":"restV"]?` · your usual ${fx(n[on?"chargeV":"restV"].lo,1)} to ${fx(n[on?"chargeV":"restV"].hi,1)}`:""}`,vs,v==null?"Unknown":vs?"Watch":"OK");
    add("Engine temperature",live.coolant==null?"No reading":`${fx(live.coolant)} °C${n.warmC?` · settles at ${fx(n.warmC.med)} °C`:""}`,live.coolant==null?"na":live.coolant>108?"bad":"",live.coolant==null?"Unknown":live.coolant>108?"Hot":live.coolant<70&&on?"Warming up":"OK");
    const tr=live.ltft==null?null:live.ltft+(live.stft||0);add("Fuel mixture correction",tr==null?"No reading":`${tr>0?"+":""}${fx(tr,1)} %${n.ltft?` · your usual ${fx(n.ltft.lo,1)} to ${fx(n.ltft.hi,1)}`:""}`,tr==null?"na":Math.abs(tr)>15?"warn":"",tr==null?"Unknown":Math.abs(tr)>15?"Watch":"OK");
    if(n.idleSd)add("Idle stability",`σ ${fx(n.idleSd.last)} rpm on the last trip · usual up to ${fx(n.idleSd.hi)}`,n.idleSd.last>n.idleSd.hi*1.5?"warn":"",n.idleSd.last>n.idleSd.hi*1.5?"Watch":"OK");
    $("#hRows").style.display="";$("#hRows").innerHTML=rows.join("");
    const all=[...stored.map(c=>[c,"stored","bad"]),...pending.filter(c=>!stored.includes(c)).map(c=>[c,"pending","warn"]),...perm.filter(c=>!stored.includes(c)).map(c=>[c,"permanent","warn"])];
    let ff="";if(all.length){const f=payloads(await link.cmd("020200")).find(p=>p.startsWith("420200"));if(f&&f.slice(6,10)!=="0000"){const vals=[];for(const k of ["rpm","speed","load","coolant","ltft","map"]){const r=payloads(await link.cmd("02"+P[k][0]+"00")).find(p=>p.startsWith("42"+P[k][0]));if(r){const b=bytesOf(r.slice(6));if(b.length>=P[k][1])vals.push(`${P[k][2].toLowerCase()} ${fx(P[k][5](...b),P[k][4])} ${P[k][3]}`)}}
        ff=`<div class="row"><div>Freeze frame for ${dtcName(f.slice(6,10))}<small>${vals.join(" · ")||"no values"}</small></div></div>`}}
    $("#dtcCap").style.display=$("#dtcRows").style.display="";
    $("#dtcRows").innerHTML=all.length?all.map(([c,k,s])=>`<div class="row"><div><b class="mono">${c}</b><small>${DTC_TEXT[c]||"Manufacturer or less common code"} · <a target="_blank" rel="noopener" href="https://www.google.com/search?q=${c}+Hyundai+Elantra">look up</a></small></div>${chip(s,k)}</div>`).join("")+ff:`<div class="row"><div>No fault codes<small>Nothing stored, pending or permanent.</small></div>${chip("","OK")}</div>`;
    $("#bClear").style.display=stored.length||pending.length?"":"none";
    if(rd&&rd.monitors.length){$("#rdyCap").style.display=$("#rdyRows").style.display="";$("#rdyRows").innerHTML=rd.monitors.map(m=>`<div class="row"><span>${m.name}</span>${chip(m.ready?"":"warn",m.ready?"Complete":"Not run yet")}</div>`).join("")}
    bad+=stored.length?1:0;warn+=model.alerts.length;
    $("#verT").textContent=bad?"Needs attention":warn?"Mostly fine, a few things to watch":"Everything looks normal";$("#verD").textContent=`Checked ${new Date().toLocaleTimeString([], {hour:"numeric",minute:"2-digit"})}. Covers the engine computer only.`;
  }catch(e){$("#verT").textContent="Check failed";$("#verD").textContent=e.message}
  $("#bHealth").disabled=false}
$("#bHealth").onclick=health;
$("#bClear").onclick=async()=>{if(!link)return alert("Connect the scanner first.");
  if(!confirm("Clear fault codes?\n\nThis turns off the check-engine light, erases the saved fault details and resets the emission monitors. If the problem is still there the code will come back. Do it with the engine off and ignition on."))return;
  const r=await link.cmd("04",6000);log("04 → "+r);alert(/44/.test(r)?"Codes cleared.":"The car did not confirm. Try with the engine off and ignition on.");health()};
function renderTrends(){const n=model.norm;$("#trends").innerHTML=[["restV","#ff9f0a"],["chargeV","#30d158"],["ltft","#0a84ff"],["idleSd","#bf5af2"],["crankMin","#ff453a"]].filter(([k])=>n[k]&&n[k].series.length>2).map(([k])=>`<div class="card"><span class="cap">${n[k].label} · ${n[k].unit} · last ${n[k].series.length} trips</span><canvas id="tr-${k}" style="height:90px"></canvas></div>`).join("");
  for(const [k,c] of [["restV","#ff9f0a"],["chargeV","#30d158"],["ltft","#0a84ff"],["idleSd","#bf5af2"],["crankMin","#ff453a"]]){const cv=$("#tr-"+k);if(cv)chart(cv,n[k].series.map((_,i)=>i+1),n[k].series,c,x=>"trip "+x)}}
const DTC_TEXT={P0011:"Intake camshaft timing over-advanced",P0014:"Exhaust camshaft timing over-advanced",P0016:"Crankshaft / camshaft position mismatch",P0101:"Air flow sensor reading out of range",P0106:"Manifold pressure sensor out of range",P0113:"Intake air temperature sensor reading high",P0128:"Engine not reaching normal temperature (thermostat)",P0131:"Oxygen sensor low voltage (bank 1, sensor 1)",P0133:"Oxygen sensor slow response (bank 1, sensor 1)",P0135:"Oxygen sensor heater fault (bank 1, sensor 1)",P0141:"Oxygen sensor heater fault (bank 1, sensor 2)",P0171:"Fuel mixture too lean",P0172:"Fuel mixture too rich",P0300:"Random misfire detected",P0301:"Misfire in cylinder 1",P0302:"Misfire in cylinder 2",P0303:"Misfire in cylinder 3",P0304:"Misfire in cylinder 4",P0325:"Knock sensor circuit fault",P0335:"Crankshaft position sensor fault",P0340:"Camshaft position sensor fault",P0420:"Catalytic converter efficiency below threshold",P0441:"Fuel vapour system purge flow fault",P0442:"Fuel vapour system small leak",P0455:"Fuel vapour system large leak (check fuel cap)",P0456:"Fuel vapour system very small leak",P0500:"Vehicle speed sensor fault",P0507:"Idle speed higher than expected",P0562:"System voltage low",P0700:"Transmission control system fault"};

/* ---------- lab ---------- */
const LAB=[["sensors","Live sensors",()=>caps?caps.keys.length+" available":"connect first"],["maps","Engine maps",()=>Object.keys(model.grid).length+" cells filled"],["dyno","Power and performance",()=>model.best.pull?fx(model.best.pull.peak)+" kW peak":"no full-throttle pull yet"],["coast","Coast-down test",()=>`CdA ${fx(S.cda,2)} · Crr ${fx(S.crr,3)}`],["mon","On-board monitor tests",()=>"Mode 06"],["uds","Manufacturer data scanner",()=>Object.keys(JSON.parse(localStorage.getItem("cp-dids")||"{}")).length+" identifiers found"],["ecu","Engine computer",()=>ecu.vin||"VIN, calibration, protocol"],["data","Export and backup",()=>trips.length+" trips"],["term","Terminal and log",()=>""],["veh","Vehicle and settings",()=>`${S.mass} kg · ${S.disp} L · ${GEO[S.geo]}`]];
function renderLab(){$("#labList").innerHTML=LAB.map(([id,n,d])=>`<div class="row tap" data-id="${id}"><span>${n}</span><span>${d()}</span></div>`).join("")}
$("#labList").onclick=e=>{const r=e.target.closest(".row");if(r)labOpen[r.dataset.id]()};
let sheetTimer=null;
const labOpen={
 sensors(){openSheet(`<h2>Live sensors</h2><div class="rows" id="senRows"><div class="empty">Connect the scanner to see every reading the car offers.</div></div>`);
   const draw=()=>{if(!caps)return;$("#senRows").innerHTML=caps.keys.map(k=>`<div class="row"><div>${P[k][2]}<small class="mono">PID ${P[k][0]}</small></div><span>${fx(live[k],P[k][4])} ${P[k][3]}</span></div>`).join("")+`<div class="row"><div>Fuel flow<small>derived${live.rate!=null?" from fuel rate":live.maf!=null?" from air flow":" from manifold pressure"}</small></div><span>${fx((live.lphEff??live.lph)*K(),2)} L/h</span></div><div class="row"><div>Crank power<small>road-load model</small></div><span>${fx(live.kw,1)} kW</span></div><div class="row"><div>Overall ratio<small>engine rpm per km/h</small></div><span>${live.speed>5?fx(live.rpm/live.speed,1):"–"}</span></div>`};
   draw();sheetTimer=setInterval(draw,500)},
 maps(){let mode=0;const M=[["Time","s"],["Ignition","°"],["Fuel trim","%"],["BSFC","g/kWh"]];
   openSheet(`<h2>Engine maps</h2><div class="seg" id="mapSeg">${M.map((m,i)=>`<button data-i="${i}" class="${i?"":"on"}">${m[0]}</button>`).join("")}</div><div class="card"><span class="cap" id="mapCap"></span><div class="heat" id="heat" style="grid-template-columns:repeat(${NR},minmax(0,1fr))"></div><div class="axis" style="grid-template-columns:repeat(${NR},minmax(0,1fr));gap:2px;font-size:8px">${Array.from({length:NR},(_,i)=>`<span>${i*RB/1000}</span>`).join("")}</div><span class="note">Across: engine speed (×1000 rpm). Up: engine load, 0 to 100 %. Built from every saved trip. BSFC uses estimated fuel flow and modelled power, so read it as a relative map.</span></div>`);
   const draw=()=>{const g=model.grid,val=c=>!c||c[0]<1?null:mode===0?c[0]:mode===1?(c[5]?c[1]/c[5]:null):mode===2?(c[6]?c[2]/c[6]:null):(c[4]>30?c[3]*K()*745/c[4]:null);
     const vs=Object.values(g).map(val).filter(x=>x!=null),mn=Math.min(...vs),mx=Math.max(...vs);let h="";
     for(let l=NL-1;l>=0;l--)for(let r=0;r<NR;r++){const v=val(g[r*NL+l]);if(v==null){h+="<div></div>";continue}const f=mx>mn?(mode===0?Math.log(1+v-mn)/Math.log(1+mx-mn):(v-mn)/(mx-mn)):.5,hue=mode===2?(v>0?28:210):mode===3?130-f*130:210-f*190,al=mode===2?Math.min(1,Math.abs(v)/12)*.85+.15:1;
       h+=`<div style="background:hsla(${hue},80%,${mode===2?50:22+f*30}%,${al})">${mode===0?(v>=60?Math.round(v/60)+"m":Math.round(v)):fx(v,mode===3?0:Math.abs(v)<10?1:0)}</div>`}
     $("#heat").innerHTML=h;$("#mapCap").textContent=vs.length?`${M[mode][0]} · ${M[mode][1]} · ${fx(mn,mode===3||mode===0?0:1)} to ${fx(mx,mode===3||mode===0?0:1)}`:"No data yet: drive with the scanner connected"};
   $("#mapSeg").onclick=e=>{const b=e.target.closest("button");if(!b)return;mode=+b.dataset.i;document.querySelectorAll("#mapSeg button").forEach(x=>x.classList.toggle("on",x===b));draw()};draw()},
 dyno(){const b=model.best,p=b.pull;openSheet(`<h2>Power and performance</h2><div class="k3"><div class="kpi"><small>Peak power</small><b>${p?fx(p.peak):"–"}</b><span>kW · ${p?fx(p.peak*1.341):"–"} hp</span></div><div class="kpi"><small>0–100 km/h</small><b>${fx(b.z100,1)}</b><span>seconds</span></div><div class="kpi"><small>80–120 km/h</small><b>${fx(b.r80,1)}</b><span>seconds</span></div></div>
   <div class="card"><span class="cap">Best full-throttle pull · crank kW against rpm</span><canvas id="dynoC" style="height:170px"></canvas></div>
   <span class="note">Power is worked out from acceleration with a road-load model: mass ${S.mass} kg, CdA ${fx(S.cda,2)} m², rolling resistance ${fx(S.crr,3)}, driveline efficiency ${fx(S.eta*100)} %. It assumes a flat road and no wind, so run it both ways on level ground. Any full-throttle run of 1,000 rpm or more is captured automatically, as are 0–100 and 80–120 times.</span>`);
   chart($("#dynoC"),p?p.pts.map(x=>x[0]):[],p?p.pts.map(x=>x[1]):[],"#bf5af2",x=>fx(x)+" rpm")},
 coast(){openSheet(`<h2>Coast-down test</h2><span class="note" style="font-size:15px;color:var(--soft)">Measures your car's real drag. On a flat, empty road with no wind: reach about 100 km/h, shift to neutral, tap Start, coast down to about 40 km/h, tap Stop. Only do this where it is safe and legal.</span>
   <button class="btn go" id="bCoast">Start recording</button><div class="card"><span class="cap">Speed while coasting · km/h</span><canvas id="coastC"></canvas></div><div class="rows" id="coastR"><div class="row"><span>Current settings</span><span>CdA ${fx(S.cda,2)} m² · Crr ${fx(S.crr,3)}</span></div></div>`);
   const btn=$("#bCoast");btn.onclick=()=>{if(!link)return alert("Connect the scanner first.");
     if(!coast||!coast.on){coast={on:true,pts:[]};btn.textContent="Stop";btn.className="btn danger";return}
     coast.on=false;btn.textContent="Start recording";btn.className="btn go";const pts=coast.pts,fit=fitCoast(pts,S.mass);chart($("#coastC"),pts.map(p=>p[0]-pts[0][0]),pts.map(p=>p[1]),"#0a84ff",hms);
     if(!fit||fit.cda<0.3||fit.cda>1.5||fit.crr<0.004||fit.crr>0.03){$("#coastR").innerHTML=`<div class="row"><div>Result not usable<small>${fit?`CdA ${fx(fit.cda,2)}, Crr ${fx(fit.crr,3)} are outside a believable range. `:""}Needs a longer, steadier coast in neutral on a flat road.</small></div></div>`;return}
     $("#coastR").innerHTML=`<div class="row"><span>Drag area (CdA)</span><span>${fx(fit.cda,3)} m²</span></div><div class="row"><span>Rolling resistance (Crr)</span><span>${fx(fit.crr,4)}</span></div><div class="row"><span>Samples used</span><span>${fit.n}</span></div>`+`<div class="row tap" id="useFit"><span>Use these values</span><span></span></div>`;
     $("#useFit").onclick=()=>{S.cda=Math.round(fit.cda*1000)/1000;S.crr=Math.round(fit.crr*10000)/10000;saveS();renderLab();alert("Saved. New trips use the measured values.")}}},
 uds(){const saved=JSON.parse(localStorage.getItem("cp-dids")||"{}"),save=()=>{localStorage.setItem("cp-dids",JSON.stringify(saved));renderLab()};let stopF=false,busy=false,prev={};
   openSheet(`<h2>Manufacturer data scanner</h2><span class="note" style="font-size:14px;color:var(--soft)">Asks one of the car's computers which manufacturer data identifiers it will answer, using read-only requests. Nothing is written to the car. Do it parked; live trip logging pauses while it runs.</span>
   <div class="g2"><label class="field"><span>Computer</span><select id="uEcu"><option value="7E0">Engine (7E0)</option><option value="7E1">Transmission (7E1)</option><option value="7E2">7E2</option><option value="7E3">7E3</option><option value="7E4">7E4</option><option value="7E5">7E5</option></select></label>
   <label class="field"><span>Service</span><select id="uSvc"><option value="22">22 · by identifier</option><option value="21">21 · data blocks</option></select></label>
   <label class="field"><span>From (hex)</span><input type="text" id="uFrom" value="F180" autocapitalize="characters" class="mono"></label><label class="field"><span>To (hex)</span><input type="text" id="uTo" value="F1FF" autocapitalize="characters" class="mono"></label></div>
   <button class="btn go" id="uGo">Start scan</button><button class="btn" id="uWatch">Watch found identifiers</button><button class="btn" id="uCsv">Export found (CSV)</button><span class="note" id="uStat">Identification data usually sits at F180 to F1FF. Live values vary by maker, so try ranges such as 0100 to 01FF, 1000 to 10FF or 2000 to 20FF, and service 21 from 00 to FF.</span><div class="rows" id="uRows"></div>`);
   const ecu=()=>$("#uEcu").value,ascii=h=>bytesOf(h).map(c=>c>=32&&c<127?String.fromCharCode(c):"·").join("");
   const draw=chg=>{const ks=Object.keys(saved).filter(k=>k.startsWith(ecu()+":")).sort();$("#uRows").innerHTML=ks.length?ks.map(k=>{const e=saved[k],b=e.hex.match(/../g)||[],p=(prev[k]||"").match(/../g)||[];
       return `<div class="row tap" data-k="${k}"><div><b class="mono">${k.slice(4,6)} ${k.slice(6)}</b> ${esc(e.name||"")}<small class="mono" style="word-break:break-all">${b.map((x,i)=>chg&&p.length&&p[i]!==x?`<span style="color:var(--orange)">${x}</span>`:x).join(" ")}<br>${esc(ascii(e.hex))}</small></div><span></span></div>`}).join(""):`<div class="empty">Nothing found for this computer yet.</div>`};
   const ask=async req=>{const p=payloads(await link.cmd(req,2500)).join(""),pos=(parseInt(req.slice(0,2),16)+0x40).toString(16).toUpperCase()+req.slice(2),i=p.indexOf(pos);return i>=0?p.slice(i+pos.length):null};
   const begin=async()=>{if(!link){alert("Connect the scanner first.");return false}if(!["6","8"].includes(caps.proto.slice(-1))){alert("This scanner mode only works on 11-bit CAN cars.");return false}if(busy)return false;busy=true;stopF=false;hold=true;await sleep(200);log("ATSH"+ecu()+" → "+await link.cmd("ATSH"+ecu()));return true};
   const end=async()=>{if(link)await link.cmd("ATSH7DF");hold=false;busy=false};
   sheetCleanup=()=>{stopF=true};draw();$("#uEcu").onchange=()=>draw();
   $("#uSvc").onchange=()=>{const s=$("#uSvc").value==="21";$("#uFrom").value=s?"00":"F180";$("#uTo").value=s?"FF":"F1FF"};
   $("#uGo").onclick=async()=>{if(busy){stopF=true;return}const svc=$("#uSvc").value,w=svc==="21"?2:4,a=parseInt($("#uFrom").value,16),b=Math.min(parseInt($("#uTo").value,16),a+2047,svc==="21"?255:65535);if(!(a>=0&&b>=a))return alert("Enter a valid hex range.");
     if(!await begin())return;const e=ecu();$("#uGo").textContent="Stop";let found=0;
     try{for(let id=a;id<=b&&!stopF&&link;id++){const hx=id.toString(16).toUpperCase().padStart(w,"0"),d=await ask(svc+hx);if(d!=null){const k=e+":"+svc+hx;saved[k]={hex:d,name:saved[k]?saved[k].name:""};found++;save();draw()}
         if($("#uStat"))$("#uStat").textContent=`Scanning ${svc} ${hx} · ${id-a+1} of ${b-a+1} · ${found} answered`}}finally{await end();if($("#uGo")){$("#uGo").textContent="Start scan";$("#uStat").textContent=`Scan ${stopF?"stopped":"finished"}: ${found} identifier${found===1?"":"s"} answered.`}}};
   $("#uWatch").onclick=async()=>{if(busy){stopF=true;return}const e=ecu(),ks=Object.keys(saved).filter(k=>k.startsWith(e+":"));if(!ks.length)return alert("Scan first so there is something to watch.");if(!await begin())return;$("#uWatch").textContent="Stop watching";
     try{while(!stopF&&link){for(const k of ks){if(stopF)break;const d=await ask(k.slice(4));if(d!=null){prev[k]=prev[k]||saved[k].hex;if(saved[k].hex!==d){prev[k]=saved[k].hex;saved[k].hex=d}}}if($("#uRows"))draw(true);if($("#uStat"))$("#uStat").textContent="Watching: bytes that changed are highlighted. Rev the engine or switch something on and see what moves.";await sleep(link.demo?300:50)}}finally{await end();save();if($("#uWatch"))$("#uWatch").textContent="Watch found identifiers"}};
   $("#uRows").onclick=e=>{const r=e.target.closest(".row");if(!r||busy)return;const k=r.dataset.k,n=prompt("Name for "+k.slice(4,6)+" "+k.slice(6)+" (leave empty to remove the name)",saved[k].name||"");if(n!=null){saved[k].name=n.trim();save();draw()}};
   $("#uCsv").onclick=()=>{const ks=Object.keys(saved).sort();if(!ks.length)return alert("Nothing found yet.");saveFile("car-pulse-identifiers.csv","computer,service,identifier,name,bytes_hex,ascii\n"+ks.map(k=>[k.slice(0,3),k.slice(4,6),k.slice(6),'"'+(saved[k].name||"").replace(/"/g,"'")+'"',saved[k].hex,'"'+ascii(saved[k].hex).replace(/"/g,"'")+'"'].join(",")).join("\n"),"text/csv")}},
 async mon(){openSheet(`<h2>On-board monitor tests</h2><span class="note">The engine computer's own self-test results (Mode 06): misfire counters, catalyst, oxygen sensors and more, each with its pass limits. Values are raw counts from the computer.</span><div class="rows" id="monR"><div class="empty">${link?"Reading…":"Connect the scanner first."}</div></div>`);if(!link)return;
   let mids=[];for(const base of [0,0x20,0x40,0x60,0x80,0xA0]){const got=parseBits(await link.cmd("06"+h2(base),4000),6,base);mids=mids.concat(got.filter(m=>m%0x20));if(!got.includes(base+0x20))break}
   const out=[];for(const m of mids)out.push(...parse06(await link.cmd("06"+h2(m),5000)));
   if($("#monR"))$("#monR").innerHTML=out.length?out.map(t=>`<div class="row"><div>${t.name}<small class="mono">value ${t.v} · limits ${t.mn} to ${t.mx}</small></div>${chip(t.pass?"":"bad",t.pass?"Pass":"Fail")}</div>`).join(""):`<div class="empty">This car did not report any monitor test results.</div>`},
 async ecu(){openSheet(`<h2>Engine computer</h2><div class="rows" id="ecuR"><div class="empty">${link?"Reading…":"Connect the scanner first."}</div></div>`);if(!link)return;
   if(!ecu.vin){ecu.vin=parseVin(await link.cmd("0902",6000));ecu.cal=parseAscii(await link.cmd("0904",6000),"04");const c=payloads(await link.cmd("0906",6000)).join("");const i=c.indexOf("4906");ecu.cvn=i>=0?c.slice(i+6,i+14):null;renderLab()}
   const pr={"6":"CAN 11-bit 500 kbaud","7":"CAN 29-bit 500 kbaud","8":"CAN 11-bit 250 kbaud","9":"CAN 29-bit 250 kbaud","3":"ISO 9141-2","4":"KWP2000 5-baud","5":"KWP2000 fast","1":"J1850 PWM","2":"J1850 VPW"}[caps.proto.slice(-1)]||caps.proto;
   if($("#ecuR"))$("#ecuR").innerHTML=[["VIN",ecu.vin||"not reported"],["Calibration ID",ecu.cal||"not reported"],["Calibration check (CVN)",ecu.cvn||"not reported"],["Protocol",pr],["Request mode",caps.batch?"6 sensors per request":caps.one?"single, fast reply":"single"],["Sensors decoded",caps.keys.length+" of "+caps.sup.filter(p=>p%0x20).length+" offered"]].map(r=>`<div class="row"><span>${r[0]}</span><span class="mono" style="font-size:13px">${esc(r[1])}</span></div>`).join("")+`<div class="row"><div>All offered PIDs<small class="mono" style="word-break:break-all">${caps.sup.filter(p=>p%0x20).map(h2).join(" ")}</small></div></div>`},
 data(){openSheet(`<h2>Export and backup</h2><button class="btn" id="xTrips">Export trip summary (CSV)</button><button class="btn" id="xBackup">Save backup file</button><input type="file" id="xFile" accept=".json,application/json" style="display:none"><button class="btn" id="xRestore">Restore backup</button><span class="note">The full sensor log of a single trip is exported from that trip's page under Insights.</span>`);
   $("#xTrips").onclick=()=>{const c=["start","source","km","minutes","litres","L_per_100km","score","hard_brakes","hard_starts","idle_s","fuel_cut_s","top_kmh","peak_rpm","start_coolant_C","ambient_C","warmup_s","charge_V","rest_V","ltft_pct","idle_rpm","idle_sd"];
     saveFile("car-pulse-trips.csv",c.join(",")+"\n"+[...trips].reverse().map(t=>[new Date(t.start).toISOString(),t.src,t.dist.toFixed(2),(t.dur/60).toFixed(1),(t.fuel*K()).toFixed(3),t.avg?(t.avg*K()).toFixed(2):"",t.score,t.brakes,t.accels,Math.round(t.idle),Math.round(t.dfco||0),t.maxV,Math.round(t.maxR),t.startC??"",t.amb??"",t.tWarm==null?"":Math.round(t.tWarm),t.chargeV??"",t.restV??"",t.ltft??"",t.idleMean==null?"":Math.round(t.idleMean),t.idleSd==null?"":t.idleSd.toFixed(1)].join(",")).join("\n"),"text/csv")};
   $("#xBackup").onclick=async()=>saveFile("car-pulse-backup-"+today()+".json",JSON.stringify({app:"carpulse",v:2,settings:S,trips,fills}),"application/json");
   $("#xRestore").onclick=()=>$("#xFile").click();
   $("#xFile").onchange=async e=>{const f=e.target.files[0];if(!f)return;try{const d=JSON.parse(await f.text());if(d.app!=="carpulse")throw new Error("Not a Car Pulse backup file.");if(!confirm(`Add ${d.trips.length} trips and ${(d.fills||[]).length} fill-ups from this backup?`))return;
       for(const t of d.trips)await Trips.put(t);for(const x of d.fills||[])await Fills.put(x);Object.assign(S,d.settings||{});saveS();await refresh();renderLab();alert("Backup restored.")}catch(err){alert("Restore failed: "+err.message)}}},
 term(){openSheet(`<h2>Terminal and log</h2><div style="display:flex;gap:8px"><label class="field" style="flex:1"><span>Command</span><input type="text" id="termIn" placeholder="ATI or 010C" autocapitalize="characters" autocomplete="off" style="font-size:17px" class="mono"></label><button class="btn sm" id="bSend" style="min-height:auto">Send</button></div><pre id="logPre">${esc(logText||"Connection log appears here.")}</pre><button class="btn" id="bCopy">Copy log</button>`);
   $("#bSend").onclick=async()=>{const c=$("#termIn").value.trim();if(!c)return;if(!link)return alert("Connect the scanner first.");log("> "+c);log(await link.cmd(c,8000)||"(no answer)");$("#termIn").value=""};
   $("#bCopy").onclick=async()=>{try{await navigator.clipboard.writeText(logText);$("#bCopy").textContent="Copied"}catch(e){alert("Could not copy. Select the text and copy it by hand.")}}},
 veh(){const F=[["tank","Fuel tank · L"],["disp","Engine size · L"],["mass","Mass with driver · kg"],["cda","Drag area CdA · m²"],["crr","Rolling resistance"],["eta","Driveline efficiency"]];
   openSheet(`<h2>Vehicle and settings</h2><div class="g2">${F.map(([k,n])=>`<label class="field"><span>${n}</span><input type="text" inputmode="decimal" data-k="${k}" value="${S[k]}"></label>`).join("")}<label class="field" style="grid-column:1/-1"><span>Fuel price city</span><select id="sGeo">${Object.entries(GEO).map(([id,n])=>`<option value="${id}" ${id==S.geo?"selected":""}>${n}</option>`).join("")}</select></label></div>
   <span class="note">Defaults are typical figures for a 2.0 L Elantra and are not confirmed for your exact car. Mass matters most for the power estimate; the coast-down test measures CdA and rolling resistance for you.</span>`);
   $("#sheetBody").onchange=e=>{const k=e.target.dataset.k;if(k){const v=num(e.target.value);if(v>0){S[k]=v;saveS()}else e.target.value=S[k]}if(e.target.id==="sGeo"){S.geo=+e.target.value;saveS();fillPrice()}renderLab();refresh()}}
};

/* ---------- navigation ---------- */
function tab(t){document.querySelectorAll("section").forEach(s=>s.classList.toggle("on",s.id==="t-"+t));document.querySelectorAll("nav button").forEach(b=>b.classList.toggle("on",b.dataset.t===t));$("main").scrollTop=0;if(t==="fuel")renderFuel();if(t==="health")renderTrends();if(t==="lab")renderLab()}
$("#nav").onclick=e=>{const b=e.target.closest("button");if(b)tab(b.dataset.t)};
function openSheet(html){if(sheetCleanup){sheetCleanup();sheetCleanup=null}clearInterval(sheetTimer);$("#sheetBody").onchange=null;$("#sheetBody").innerHTML=html;$("#sheet").classList.add("on");$("#sheetBody").scrollTop=0}
function closeSheet(){if(sheetCleanup){sheetCleanup();sheetCleanup=null}clearInterval(sheetTimer);$("#sheet").classList.remove("on");$("#sheetBody").innerHTML=""}
$("#bBack").onclick=closeSheet;
$("#bConnect").onclick=()=>start("ble");$("#bDemo").onclick=()=>start("demo");$("#bEnd").onclick=()=>stop(false);
$("#fDate").value=today();renderDrive();renderLab();refresh().then(fillPrice);
try{if(location.protocol.startsWith("http")&&navigator.serviceWorker)navigator.serviceWorker.register("sw.js").catch(()=>{})}catch(e){}
