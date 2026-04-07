// supabase/functions/send-alert/index.ts
// Edge function: accepts alert details + targeting criteria, batch-inserts into user_alerts,
// optionally sends emails via the existing send-email function.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.55.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BATCH_SIZE = 100;

interface AlertPayload {
  title: string;
  description: string;
  severity?: "info" | "warning" | "error" | "success";
  category?: string;
  action_url?: string;
  action_label?: string;
  metadata?: Record<string, unknown>;
  sent_by: string;               // admin user id
  university_id: string;
  // Targeting
  target_type: "all" | "by_stage" | "individual";
  target_stage?: string;          // required when target_type === 'by_stage'
  student_ids?: string[];         // required when target_type === 'individual'
  send_email?: boolean;           // whether to also send emails
}

serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  try {
    const payload: AlertPayload = await req.json();
    const {
      title,
      description,
      severity = "info",
      category = "admin_alert",
      action_url = null,
      action_label = null,
      metadata = null,
      sent_by,
      university_id,
      target_type,
      target_stage,
      student_ids,
      send_email = false,
    } = payload;

    // Validate required fields
    if (!title || !description || !sent_by || !university_id || !target_type) {
      return jsonResponse({ error: "Missing required fields: title, description, sent_by, university_id, target_type" }, 400);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // ------------------------------------------------------------------
    // 1. Resolve target student IDs
    // ------------------------------------------------------------------
    let resolvedIds: string[] = [];

    if (target_type === "all") {
      const { data: students, error } = await supabase
        .from("students")
        .select("id")
        .eq("university_id", university_id);
      if (error) throw error;
      resolvedIds = (students ?? []).map((s: { id: string }) => s.id);
    } else if (target_type === "by_stage") {
      if (!target_stage) {
        return jsonResponse({ error: "target_stage is required when target_type is by_stage" }, 400);
      }
      const { data: students, error } = await supabase
        .from("students")
        .select("id")
        .eq("university_id", university_id)
        .eq("stage", target_stage);
      if (error) throw error;
      resolvedIds = (students ?? []).map((s: { id: string }) => s.id);
    } else if (target_type === "individual") {
      if (!student_ids || student_ids.length === 0) {
        return jsonResponse({ error: "student_ids required when target_type is individual" }, 400);
      }
      resolvedIds = student_ids;
    }

    if (resolvedIds.length === 0) {
      return jsonResponse({ alerts_created: 0, emails_sent: 0, emails_failed: 0, message: "No matching students found" });
    }

    // ------------------------------------------------------------------
    // 2. Batch-insert alerts (100 per batch)
    // ------------------------------------------------------------------
    const rows = resolvedIds.map((studentId) => ({
      university_id,
      student_id: studentId,
      category,
      severity,
      title,
      description,
      metadata: metadata ? JSON.stringify(metadata) : null,
      action_url,
      action_label,
      read: false,
      dismissed: false,
      sent_by,
      target_type,
      target_stage: target_stage ?? null,
      email_sent: false,
    }));

    let alertsCreated = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const { data, error } = await supabase.from("user_alerts").insert(batch).select("id");
      if (error) {
        console.error("Batch insert error:", error);
        continue;
      }
      alertsCreated += data?.length ?? 0;
    }

    // ------------------------------------------------------------------
    // 3. Optional: send emails via existing send-email function
    // ------------------------------------------------------------------
    let emailsSent = 0;
    let emailsFailed = 0;

    if (send_email) {
      // Fetch email addresses for resolved students
      const { data: students } = await supabase
        .from("students")
        .select("id, email")
        .in("id", resolvedIds);

      const emailMap = new Map((students ?? []).map((s: { id: string; email: string }) => [s.id, s.email]));

      for (const studentId of resolvedIds) {
        const email = emailMap.get(studentId);
        if (!email) {
          emailsFailed++;
          continue;
        }
        try {
          const emailRes = await supabase.functions.invoke("send-email", {
            body: {
              to: email,
              subject: `[Alert] ${title}`,
              html: `<h2>${title}</h2><p>${description}</p>${action_url ? `<p><a href="${action_url}">${action_label || "View"}</a></p>` : ""}`,
            },
          });
          if (emailRes.error) {
            emailsFailed++;
          } else {
            emailsSent++;
            // mark email_sent = true
            await supabase
              .from("user_alerts")
              .update({ email_sent: true })
              .eq("student_id", studentId)
              .eq("title", title)
              .eq("sent_by", sent_by)
              .order("created_at", { ascending: false })
              .limit(1);
          }
        } catch {
          emailsFailed++;
        }
      }
    }

    return jsonResponse({
      alerts_created: alertsCreated,
      emails_sent: emailsSent,
      emails_failed: emailsFailed,
      target_count: resolvedIds.length,
    });
  } catch (err) {
    console.error("send-alert error:", err);
    return jsonResponse({ error: (err as Error).message }, 500);
  }
});

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
