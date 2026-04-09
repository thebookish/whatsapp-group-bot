
const path = require('path');
const { createClient } = require('@supabase/supabase-js');


const supabaseUrl = process.env.SUPABASE_URL || 'https://yfirahnrstwtmeymwftz.supabase.co';
const supabaseKey = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlmaXJhaG5yc3R3dG1leW13ZnR6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDU1OTcsImV4cCI6MjA5MTMyMTU5N30.b72paitbUzaMInFqndvBPJB_2WEFL0a8QNSL_iYgbms';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY 
const DATA_FILE = process.env.PROVIDERS_DATA_PATH || path.join(process.cwd(), 'providers_with_courses.json');
const NESTORIA_ENDPOINT =
  (process.env.NESTORIA_ENDPOINT && process.env.NESTORIA_ENDPOINT.trim()) ||
  'https://api.nestoria.co.uk/api'; 
const supabase = createClient(supabaseUrl, supabaseKey);


module.exports = {
supabase,
OPENROUTER_API_KEY,
DATA_FILE,
NESTORIA_ENDPOINT,
DATA_ARRAY_KEY: process.env.DATA_ARRAY_KEY || 'records',
};
