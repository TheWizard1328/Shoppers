import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
const toRad=(d:number)=>d*Math.PI/180;
const hKm=(a:number,b:number,c:number,d:number)=>{const R=6371,x=toRad(c-a),y=toRad(d-b),s=Math.sin(x/2)**2+Math.cos(toRad(a))*Math.cos(toRad(c))*Math.sin(y/2)**2;return R*2*Math.atan2(Math.sqrt(s),Math.sqrt(1-s))};
const off=(la:number,lo:number,km:number,ang:number)=>{const R=6371,b=toRad(ang),l=toRad(la),a=km/R;const n=Math.asin(Math.sin(l)*Math.cos(a)+Math.cos(l)*Math.sin(a)*Math.cos(b));const no=toRad(lo)+Math.atan2(Math.sin(b)*Math.sin(a)*Math.cos(l),Math.cos(a)-Math.sin(l)*Math.sin(n));return{latitude:+(n*180/Math.PI).toFixed(6),longitude:+(no*180/Math.PI).toFixed(6)}};
const pick=<T>(a:T[])=>a[Math.floor(Math.random()*a.length)];
const ri=(a:number,b:number)=>Math.floor(Math.random()*(b-a+1))+a;
const ra=(a:number,b:number)=>Math.random()*(b-a)+a;
const aD=(d:Date,n:number)=>{const r=new Date(d);r.setDate(r.getDate()+n);return r};
const fD=(d:Date)=>d.toISOString().split('T')[0];
const bDT=(d:Date,t:string)=>`${fD(d)}T${t}:00`;
const h2m=(t:string)=>{const[h,m]=t.split(':').map(Number);return h*60+m};
const m2h=(m:number)=>`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
const aM=(t:string,n:number)=>m2h(h2m(t)+n);
const gId=(l:number)=>Array.from({length:l},()=>'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'[ri(0,53)]).join('');
const SN=['Maple','Oak','Cedar','Pine','Spruce','River','Lake','Hill','Park','Elm','82','104','118','137','156','170','178','199','Jasper','Whyte','Calgary','St Albert'];
const ST=['Street','Avenue','Road','Drive','Boulevard','Lane','Court','Crescent'];
const FN=['Emma','Olivia','Sophia','Ava','Mia','Sarah','Jennifer','Michael','David','James','Robert','Linda','Patricia','Susan','Karen','Nancy','Lisa','Betty','Margaret','Sandra','Ashley','Emily','Stephen','Chris','Mark','Daniel','Matthew','Andrew','Thomas'];
const LN=['Johnson','Smith','Brown','Taylor','Wilson','Martin','Lee','Clark','Young','Hall','Allen','King','Wright','Lopez','Hill','Scott','Green','Adams','Baker','Nelson','Carter','Mitchell','Roberts','Turner','Phillips','Campbell','Parker','Evans','Edwards','Collins','Stewart','Morris','Rogers','Reed','Cook','Morgan','Bell','Murphy','Bailey','Cooper','Howard','Ward','Torres','Peterson','Gray','Ramirez','Watson','Brooks','Russell','Hayes','Price','Bennett','Wood','Barnes','Ross','Henderson','Coleman','Jenkins','Perry','Powell','Long','Patterson','Hughes','Flores','Butler','Simmons','Foster','Bryant','Alexander','Robinson','Shaw','Garcia'];
const NT=['Leave at front desk','Ring bell twice','Call on arrival','Side entrance','Fragile package','Mailbox OK','Back door',''];
function gP(sLa:number,sLo:number,n:number){const p=[];for(let i=0;i<n;i++){const d=ra(0.3,18),a=ra(0,360),c=off(sLa,sLo,d,a);p.push({fn:`${pick(FN)} ${pick(LN)}`,ad:`${ri(100,9999)} ${pick(SN)} ${pick(ST)}`,la:c.latitude,lo:c.longitude,km:+d.toFixed(2),ph:`(780) ${ri(200,999)}-${String(ri(1000,9999)).padStart(4,'0')}`,no:pick(NT),ts:pick(['09:00','10:00','11:00','13:00','14:00']),te:pick(['12:00','14:00','16:00','18:00','20:00'])});}return p;}
function sNN(sLa:number,sLo:number,p:any[]){const r=[...p],s:any[]=[];let cLa=sLa,cLo=sLo;while(r.length){let mi=0,md=Infinity;for(let i=0;i<r.length;i++){const d=hKm(cLa,cLo,r[i].la,r[i].lo);if(d<md){md=d;mi=i;}}const n=r.splice(mi,1)[0];s.push(n);cLa=n.la;cLo=n.lo;}return s;}
Deno.serve(async(req)=>{
try{
const b44=createClientFromRequest(req);
const u=await b44.auth.me();
if(!u)return Response.json({error:'Unauthorized'},{status:401});
if(u.role!=='admin')return Response.json({error:'Admin only'},{status:403});
const body=await req.json().catch(()=>({}));
const ws=body.week_start_date?new Date(body.week_start_date):(()=>{const d=new Date();const dow=d.getDay();d.setDate(d.getDate()+(dow===0?1:8-dow));return d;})();
const clear=body.clear_existing!==false;
const db=b44.asServiceRole;
const st={stores:0,drivers:0,patients:0,routes:0,failed:0,returns:0};
if(clear){
const[rs,ps,us,ss]=await Promise.all([db.entities.DemoRoute.filter({},'created_date',500,0),db.entities.DemoPatient.filter({},'created_date',500,0),db.entities.DemoAppUser.filter({},'created_date',500,0),db.entities.DemoStore.filter({},'created_date',500,0)]);
await Promise.all([...rs.map((r:any)=>db.entities.DemoRoute.delete(r.id).catch(()=>{})),...ps.map((p:any)=>db.entities.DemoPatient.delete(p.id).catch(()=>{})),...us.map((u:any)=>db.entities.DemoAppUser.delete(u.id).catch(()=>{})),...ss.map((s:any)=>db.entities.DemoStore.delete(s.id).catch(()=>{}))]);
}
const rS=await db.entities.Store.filter({status:'active'},'sort_order',500,0);
const rD=await db.entities.AppUser.filter({status:'active'},'sort_order',500,0);
const dU=rD.filter((d:any)=>d.app_roles?.includes('driver')||d.app_roles?.includes('admin'));
for(const d of dU){
await db.entities.DemoAppUser.create({user_id:d.user_id||d.id,app_roles:d.app_roles||['driver'],user_name:d.user_name||d.full_name||'Driver',home_latitude:d.home_latitude,home_longitude:d.home_longitude,city_id:d.city_id,store_ids:d.store_ids||[],sort_order:d.sort_order||99,status:'active',driver_status:'off_duty',location_tracking_enabled:true,pay_rate_per_delivery:d.pay_rate_per_delivery||5.50,extra_km_rate:d.extra_km_rate||0.55,extra_km_limit:d.extra_km_limit||10,oversized_item_rate:d.oversized_item_rate||1.5,pay_cycle_type:d.pay_cycle_type||'semimonthly',gst_hst_enabled:d.gst_hst_enabled||false,is_demo:true});
st.drivers++;}
for(const s of rS){
await db.entities.DemoStore.create({name:s.name,abbreviation:s.abbreviation||s.name?.substring(0,2).toUpperCase(),address:s.address||'',phone:s.phone||'(780) 555-0000',latitude:s.latitude,longitude:s.longitude,city_id:s.city_id,color:s.color||'#008282',status:'active',sort_order:s.sort_order||99,base_tracking_number:0,weekday_am_enabled:!!s.weekday_am_enabled,weekday_am_start:s.weekday_am_start||'',weekday_am_end:s.weekday_am_end||'',weekday_am_driver_id:s.weekday_am_driver_id||null,weekday_pm_enabled:!!s.weekday_pm_enabled,weekday_pm_start:s.weekday_pm_start||'',weekday_pm_end:s.weekday_pm_end||'',weekday_pm_driver_id:s.weekday_pm_driver_id||null,saturday_am_enabled:!!s.saturday_am_enabled,saturday_am_start:s.saturday_am_start||'',saturday_am_end:s.saturday_am_end||'',saturday_am_driver_id:s.saturday_am_driver_id||null,sunday_am_enabled:!!s.sunday_am_enabled,sunday_am_start:s.sunday_am_start||'',sunday_am_end:s.sunday_am_end||'',sunday_am_driver_id:s.sunday_am_driver_id||null,is_demo:true});
st.stores++;}
const eS=await db.entities.DemoSettings.filter({user_id:u.id});
if(eS.length>0)await db.entities.DemoSettings.update(eS[0].id,{is_demo_mode_active:true,demo_store_id:null});
else await db.entities.DemoSettings.create({user_id:u.id,is_demo_mode_active:true,demo_store_id:null});
const idSet=new Set<string>();
const gSid=()=>{let id:string;do{id=gId(3);}while(idSet.has(id));idSet.add(id);return id;};
const pools=new Map<string,any[]>();
for(const s of rS)pools.set(s.id,gP(s.latitude,s.longitude,25));
for(let di=0;di<7;di++){
const dd=aD(ws,di),ds=fD(dd),we=di>=5,dow=dd.getDay();
for(const store of rS){
const slots:{k:string;s:string;e:string;did:string}[]=[];
if(dow>=1&&dow<=5){
if(store.weekday_am_enabled&&store.weekday_am_driver_id)slots.push({k:'am',s:store.weekday_am_start,e:store.weekday_am_end,did:store.weekday_am_driver_id});
if(store.weekday_pm_enabled&&store.weekday_pm_driver_id)slots.push({k:'pm',s:store.weekday_pm_start,e:store.weekday_pm_end,did:store.weekday_pm_driver_id});
}else if(dow===6){if(store.saturday_am_enabled&&store.saturday_am_driver_id)slots.push({k:'sat',s:store.saturday_am_start,e:store.saturday_am_end,did:store.saturday_am_driver_id});
}else if(dow===0){if(store.sunday_am_enabled&&store.sunday_am_driver_id)slots.push({k:'sun',s:store.sunday_am_start,e:store.sunday_am_end,did:store.sunday_am_driver_id});}
for(const slot of slots){
const dr=dU.find((d:any)=>(d.user_id||d.id)===slot.did);
if(!dr)continue;
const did=slot.did,dn=dr.user_name||dr.full_name||'Driver',am=slot.k.includes('am');
const nd=we?ri(5,10):ri(5,12),pool=pools.get(store.id)!;
const sp:any[]=[];for(let i=0;i<nd;i++)sp.push(pool[(di*7+i)%pool.length]);
const sorted=sNN(store.latitude,store.longitude,sp);
const psid=gSid(),pso=1;
await db.entities.DemoRoute.create({delivery_id:`DEMO-PICKUP-${store.id}-${did}-${ds}-${slot.k}`,patient_id:'',driver_id:did,driver_name:dn,created_by_app_user_id:u.id,delivery_date:ds,delivery_time_start:slot.s,delivery_time_end:slot.e,delivery_time_eta:slot.s,actual_delivery_time:bDT(dd,aM(slot.s,ri(3,15))),status:'completed',store_id:store.id,tracking_number:'00',stop_order:pso,stop_id:psid,puid:psid,delivery_notes:`Store pickup: ${store.name}`,ampm_deliveries:am?'AM':'PM',extra_time:5,latitude:store.latitude,longitude:store.longitude,transport_mode:'driving',is_demo:true});
st.routes++;
let ltm=h2m(slot.s)+20;
for(let i=0;i<sorted.length;i++){
const pt=sorted[i],so=pso+1+i,tn=String(so).padStart(2,'0'),dur=ri(15,30);
ltm+=dur;const dt=m2h(Math.min(ltm,20*60));
const sr=Math.random();let status='completed';if(sr<0.05)status='failed';else if(sr<0.08)status='cancelled';
const cr=Math.random();let ct='No Payment',ca='',crq=0;
if(cr<0.15){ct='Cash';ca=String(ri(10,80));crq=parseFloat(ca);}else if(cr<0.25){ct='Debit';ca=String(ri(15,120));crq=parseFloat(ca);}else if(cr<0.30){ct='Credit';ca=String(ri(15,120));crq=parseFloat(ca);}
const at=(status!=='pending')?bDT(dd,dt):'';
const pid=`DEMO-P-${store.id?.slice(-6)}-${gId(5)}`;
const cp=await db.entities.DemoPatient.create({store_id:store.id,full_name:pt.fn,patient_id:pid,address:pt.ad,latitude:pt.la,longitude:pt.lo,distance_from_store:pt.km,phone:pt.ph,notes:pt.no,mailbox_ok:Math.random()>0.5,call_upon_arrival:Math.random()>0.6,ring_bell:Math.random()>0.2,dont_ring_bell:Math.random()>0.85,back_door:Math.random()>0.8,time_window_start:pt.ts,time_window_end:pt.te,status:'active',is_demo:true}).catch(()=>null);
if(cp)st.patients++;
await db.entities.DemoRoute.create({delivery_id:`DEMO-DEL-${store.id?.slice(-6)}-${did?.slice(-4)}-${ds}-${slot.k.toUpperCase()}-${i+1}`,patient_id:cp?.id||pid,driver_id:did,driver_name:dn,created_by_app_user_id:u.id,delivery_date:ds,delivery_time_start:pt.ts||aM(slot.s,30+i*25),delivery_time_end:pt.te||aM(pt.ts||slot.s,120),delivery_time_eta:aM(dt,-ri(0,15)),arrival_time:bDT(dd,aM(dt,-ri(2,8))),actual_delivery_time:at,status,store_id:store.id,tracking_number:tn,stop_order:so,stop_id:gSid(),puid:psid,delivery_notes:status==='failed'?pick(['Patient not home','Address issue','Delivery delayed']):status==='cancelled'?'Cancelled by pharmacy':pt.no||'Delivered',ampm_deliveries:am?'AM':'PM',extra_time:5,cod_payment_type:ct,cod_amount:ca,cod_total_amount_required:crq,signature_needed:Math.random()<0.35,signature_image_url:Math.random()<0.35&&status==='completed'?'demo-sig.png':'',fridge_item:Math.random()<0.12,oversized:Math.random()<0.08,first_delivery:Math.random()<0.15,latitude:pt.la,longitude:pt.lo,estimated_distance_km:+hKm(store.latitude,store.longitude,pt.la,pt.lo).toFixed(2),transport_mode:'driving',is_demo:true});
st.routes++;
if(status==='failed'){st.failed++;if(Math.random()<0.6){const rd=aD(dd,1);await db.entities.DemoRoute.create({delivery_id:`DEMO-RETRY-${store.id?.slice(-6)}-${did?.slice(-4)}-${fD(rd)}-${i+1}`,patient_id:cp?.id||pid,driver_id:did,driver_name:dn,created_by_app_user_id:u.id,delivery_date:fD(rd),delivery_time_start:aM(pt.ts||slot.s,60),delivery_time_end:aM(pt.te||'18:00',60),actual_delivery_time:bDT(rd,aM(pt.ts||slot.s,ri(60,90))),status:'completed',store_id:store.id,tracking_number:`${tn}R`,stop_order:so+100,stop_id:gSid(),puid:psid,delivery_notes:'Retry: delivered after failed attempt',ampm_deliveries:am?'AM':'PM',extra_time:5,latitude:pt.la,longitude:pt.lo,is_demo:true});st.routes++;}else{st.returns++;await db.entities.DemoRoute.create({delivery_id:`DEMO-RET-${store.id?.slice(-6)}-${did?.slice(-4)}-${ds}-${i+1}`,patient_id:'',driver_id:did,driver_name:dn,created_by_app_user_id:u.id,delivery_date:ds,delivery_time_start:aM(slot.e||'17:00',30),delivery_time_end:aM(slot.e||'17:00',45),actual_delivery_time:bDT(dd,aM(slot.e||'17:00',ri(30,45))),status:'completed',store_id:store.id,tracking_number:`${tn}T`,stop_order:999,stop_id:gSid(),puid:psid,delivery_notes:`Return: ${store.name} Return\nFor: ${pt.fn}`,ampm_deliveries:am?'AM':'PM',extra_time:5,latitude:store.latitude,longitude:store.longitude,is_demo:true});st.routes++;}}
}
}
}
}
return Response.json({success:true,week_start:fD(ws),stats:{...st,total:(await db.entities.DemoRoute.filter({},'created_date',500,0)).length}});
}catch(e){return Response.json({error:e.message,stack:e.stack},{status:500});}
});
