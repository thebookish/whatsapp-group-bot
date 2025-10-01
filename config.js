
const path = require('path');
const { createClient } = require('@supabase/supabase-js');


const supabaseUrl = process.env.SUPABASE_URL || 'https://jlznlwkluocqjnepxwbv.supabase.co';
const supabaseKey = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impsem5sd2tsdW9jcWpuZXB4d2J2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU3MDA3MDAsImV4cCI6MjA3MTI3NjcwMH0.8gFwwwcV9w2Pcs-QObN2uyuxnf9lGjzhRotR56BMTwo';
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
