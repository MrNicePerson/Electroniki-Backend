import 'dotenv/config';
import mongoose from 'mongoose';
import { MongooseModels as M } from './server/models/schemas.js';
try {
 await mongoose.connect(process.env.MONGODB_URI,{serverSelectionTimeoutMS:10000});
 const names=['Shop','Product','Supplier','StockReceipt','StockMovement','FinancialTransaction'];
 const collections=[];
 for(const name of names){collections.push({collection:M[name].collection.name,documents:await M[name].countDocuments()});}
 const sample=await M.Product.findOne({code:/^DEMO-/}).select('name code shopId').lean();
 console.log(JSON.stringify({database:mongoose.connection.name,collections,demoProduct:sample},null,2));
} catch(e){console.error(e.message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/g,'[redacted]'));process.exitCode=1;}finally{await mongoose.disconnect();}
