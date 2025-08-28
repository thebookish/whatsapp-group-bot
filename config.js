const { createClient } = require('@supabase/supabase-js');


const supabaseUrl = process.env.SUPABASE_URL || 'https://jlznlwkluocqjnepxwbv.supabase.co';
const supabaseKey = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impsem5sd2tsdW9jcWpuZXB4d2J2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU3MDA3MDAsImV4cCI6MjA3MTI3NjcwMH0.8gFwwwcV9w2Pcs-QObN2uyuxnf9lGjzhRotR56BMTwo';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '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';


const supabase = createClient(supabaseUrl, supabaseKey);


module.exports = {
supabase,
OPENROUTER_API_KEY,
};