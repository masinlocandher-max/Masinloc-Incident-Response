import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL=Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY=Deno.env.get("SUPABASE_ANON_KEY")!;
const admin=createClient(SUPABASE_URL,SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const publicAuth=createClient(SUPABASE_URL,ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const ALLOWED_ORIGINS=new Set(["https://masinloc-zambales.com","https://www.masinloc-zambales.com","https://masinloc-website.vercel.app"]);

type Agency="pnp"|"mdrrmo";
function headers(req:Request){const origin=req.headers.get("origin")||"";return{"Access-Control-Allow-Origin":ALLOWED_ORIGINS.has(origin)?origin:"null","Access-Control-Allow-Headers":"content-type, x-client-info, apikey, authorization","Access-Control-Allow-Methods":"POST, OPTIONS","Content-Type":"application/json","Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Vary":"Origin"}}
function reply(req:Request,status:number,data:Record<string,unknown>){return new Response(JSON.stringify(data),{status,headers:headers(req)})}
function bearer(req:Request){const h=req.headers.get("authorization")||"";return h.toLowerCase().startsWith("bearer ")?h.slice(7).trim():""}
function validEmail(v:unknown){const email=String(v||"").trim().toLowerCase();if(email.length<5||email.length>254||!email.includes("@"))throw new Error("VALIDATION");return email}
async function requireAdmin(req:Request){const token=bearer(req);if(!token)throw new Error("AUTH");const {data,error}=await admin.auth.getUser(token);if(error||!data.user)throw new Error("AUTH");if(data.user.app_metadata?.role!=="admin")throw new Error("FORBIDDEN");return data.user}
async function findUser(email:string){let page=1;for(;;){const {data,error}=await admin.auth.admin.listUsers({page,perPage:200});if(error)throw error;const found=data.users.find(u=>String(u.email||"").toLowerCase()===email);if(found)return found;if(data.users.length<200)return null;page+=1;if(page>20)throw new Error("USER_LOOKUP_LIMIT")}}

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:headers(req)});
  if(req.method!=="POST")return reply(req,405,{ok:false,error:"Method not allowed."});
  const origin=req.headers.get("origin")||"";
  if(origin&&!ALLOWED_ORIGINS.has(origin))return reply(req,403,{ok:false,error:"Origin not allowed."});
  try{
    await requireAdmin(req);
    const raw=await req.json().catch(()=>({}));
    const email=validEmail(raw.email);
    const agency=String(raw.agency||"") as Agency;
    if(!["pnp","mdrrmo"].includes(agency))throw new Error("VALIDATION");
    const redirectTo=`https://www.masinloc-zambales.com/emergency/${agency}.html`;

    let user=await findUser(email);
    let created=false;
    if(!user){
      const {data,error}=await admin.auth.admin.createUser({email,email_confirm:false});
      if(error)throw error;
      user=data.user;
      created=true;
    }

    const {error:mailError}=await publicAuth.auth.signInWithOtp({email,options:{shouldCreateUser:false,emailRedirectTo:redirectTo}});
    if(mailError)throw mailError;

    return reply(req,200,{ok:true,created,agency,message:"Secure email sent. Use only the newest link."});
  }catch(err){
    const message=err instanceof Error?err.message:"SERVER";
    console.error("emergency_responder_admin_error",message);
    if(message==="VALIDATION")return reply(req,400,{ok:false,error:"Enter a valid responder email and agency."});
    if(message==="AUTH")return reply(req,401,{ok:false,error:"Administrator session expired. Sign in again."});
    if(message==="FORBIDDEN")return reply(req,403,{ok:false,error:"Only a platform administrator can onboard responders."});
    return reply(req,500,{ok:false,error:"Could not prepare responder email access. Please try again."});
  }
});
