import 'dotenv/config';
import mongoose from 'mongoose';
import { MongooseModels as M } from './server/models/schemas.js';
const groups = [
 { supplier:'Demo Mobile Distributors', method:'credit', paid:0, items:[
 ['Samsung Galaxy A15','Mobile',8,42000,48000],['Redmi Note 13','Mobile',4,46000,52500],
 ['Infinix Hot 40','Mobile',2,31000,36500],['USB-C Fast Charger 25W','Accessories',20,1500,2200]] },
 { supplier:'Demo Home Electronics', method:'bank', paid:50000, items:[
 ['Haier LED TV 43 inch','Television',3,68000,78000],['Dawlance Microwave 20L','Home Appliances',6,24500,28500],
 ['Philips Steam Iron','Home Appliances',1,8500,10500]] },
 { supplier:'Demo Computer Supplies', method:'cash', paid:20000, items:[
 ['HP Laptop Core i5 8GB 256GB','Laptop',2,95000,110000],['Logitech Wireless Mouse','Accessories',12,1800,2500],
 ['Kingston USB Drive 64GB','Accessories',15,1200,1650]] }
];
try {
 await mongoose.connect(process.env.MONGODB_URI,{serverSelectionTimeoutMS:10000});
 const shops=await M.Shop.find().select('_id name').lean();
 const target=process.argv[2];
 if(!target && shops.length!==1) throw Error('Multiple shops found. Pass the target shop ID.');
 const shop=target?shops.find(s=>String(s._id)===target):shops[0];
 if(!shop) throw Error('Target shop not found.');
 const shopId=String(shop._id),date=new Date().toISOString().slice(0,10);
 // Pre-create collections/indexes before starting the Atlas transaction.
 for(const name of ['Product','Supplier','StockReceipt','StockMovement','BankAccount','FinancialTransaction','AuditEvent']) await M[name].init();
 const session=await mongoose.startSession();
 let added=0,skipped=0;
 try { await session.withTransaction(async()=>{
  added=0;skipped=0;
  for(let g=0;g<groups.length;g++){
   const group=groups[g],invoiceNo=`DEMO-STOCK-00${g+1}`,receiptNo=`DEMO-REC-00${g+1}`;
   if(await M.StockReceipt.exists({shopId,invoiceNo}).session(session)){skipped++;continue;}
   const lines=[];
   for(let i=0;i<group.items.length;i++){
    const [name,category,qty,cost,price]=group.items[i],code=`DEMO-${g+1}0${i+1}`,barcode=`99000000${g+1}0${i+1}`;
    if(await M.Product.exists({shopId,code}).session(session)) throw Error(`Existing ${code} has no demo receipt; refusing to overwrite.`);
    const [p]=await M.Product.create([{shopId,name,code,barcode,category,cost,price,stock:qty,warranty:'12 Months',reorderThreshold:5,active:true}],{session});
    lines.push({productId:String(p._id),name,code,qty,cost,price});
    await M.StockMovement.create([{shopId,productId:String(p._id),productName:name,code,type:'receive',qtyChange:qty,stockAfter:qty,unitCost:cost,unitPrice:price,referenceId:invoiceNo,note:'User-requested demo stock',createdBy:'Demo Import'}],{session});
    added++;
   }
   const total=lines.reduce((sum,l)=>sum+l.qty*l.cost,0),balance=total-group.paid;
   const supplier=await M.Supplier.findOneAndUpdate({shopId,name:group.supplier},{$set:{lastPurchaseDate:date},$setOnInsert:{contactPerson:'Demo Supplier',phone:'',address:'',openingBalance:0,status:'Active'},$inc:{balancePayable:balance}},{session,upsert:true,new:true,runValidators:true});
   await M.StockReceipt.create([{shopId,receiptNo,supplierId:String(supplier._id),supplier:group.supplier,invoiceNo,invoiceKey:JSON.stringify([group.supplier.toLowerCase(),invoiceNo.toLowerCase()]),date,total,items:lines,payment:{method:group.method,paid:group.paid,balance,bankName:group.method==='bank'?'HBL':'',reference:invoiceNo},idempotencyKey:invoiceNo,createdBy:'Demo Import'}],{session});
   if(group.paid>0){
    await M.FinancialTransaction.create([{shopId,txNo:`DEMO-FIN-00${g+1}`,type:'supplier_payment',direction:'out',amount:group.paid,method:group.method,bankName:group.method==='bank'?'HBL':'',reference:invoiceNo,partyName:group.supplier,relatedId:receiptNo,note:'User-requested demo supplier payment',createdBy:'Demo Import'}],{session});
    if(group.method==='bank')await M.BankAccount.findOneAndUpdate({shopId,bankName:'HBL'},{$inc:{balance:-group.paid},$setOnInsert:{accountTitle:shop.name,openingBalance:0,logo:'/assets/payment-banks/hbl.png',active:true}},{session,upsert:true,runValidators:true});
   }
   await M.AuditEvent.create([{shopId,action:'demo_stock_imported',entityType:'StockReceipt',entityId:receiptNo,summary:`User-requested demo stock ${invoiceNo}`,actorName:'Demo Import',actorRole:'owner'}],{session});
  }
 });}finally{await session.endSession();}
 const [products,receipts,suppliers]=await Promise.all([M.Product.find({shopId,code:/^DEMO-/}).lean(),M.StockReceipt.find({shopId,invoiceNo:/^DEMO-STOCK-/}).lean(),M.Supplier.countDocuments({shopId,name:/^Demo /})]);
 console.log(JSON.stringify({shop:shop.name,addedProducts:added,skippedReceipts:skipped,verified:{products:products.length,units:products.reduce((s,p)=>s+p.stock,0),receipts:receipts.length,suppliers,purchaseTotal:receipts.reduce((s,r)=>s+r.total,0),paidTotal:receipts.reduce((s,r)=>s+r.payment.paid,0)}}));
}catch(e){console.error(e.message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/g,'[redacted]'));process.exitCode=1;}finally{await mongoose.disconnect();}
