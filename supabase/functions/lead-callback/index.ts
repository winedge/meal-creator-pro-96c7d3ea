// Receives the "call finished" webhook from AIMedicalls (aimedicalls.com) and
// saves the result - summary, transcript and the recording itself - on the
// matching submission.
//
// Secrets (Lovable Cloud -> Secrets):
//   AIMEDICALLS_CALLBACK_SECRET   the LEAD_CALLBACK_SECRET from the AIMedicalls server
// Provided automatically: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
import { createClient } from 'npm:@supabase/supabase-js@2';

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_SKEW_SECONDS = 300;

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function hmacHex(secret: string, data: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);

  const secret = Deno.env.get('AIMEDICALLS_CALLBACK_SECRET');
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!secret || !url || !serviceKey) return reply({ error: 'Callback receiver is not configured' }, 503);

  // 1. Verify the signature: HMAC-SHA256(secret, `${timestamp}.${rawBody}`)
  const raw = await req.text();
  const ts = req.headers.get('x-callback-timestamp') ?? '';
  const given = (req.headers.get('x-callback-signature') ?? '').replace(/^sha256=/, '');
  if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > MAX_SKEW_SECONDS) return reply({ error: 'Stale or missing timestamp' }, 401);
  if (!given || !safeEqual(given, await hmacHex(secret, `${ts}.${raw}`))) return reply({ error: 'Invalid signature' }, 401);

  let p: any;
  try { p = JSON.parse(raw); } catch { return reply({ error: 'Invalid JSON' }, 400); }

  // 2. Find the submission (external_id is the submission id we sent with the lead).
  const submissionId = typeof p.external_id === 'string' ? p.external_id : '';
  if (!/^[0-9a-f-]{36}$/i.test(submissionId)) return reply({ error: 'Missing external_id' }, 422);
  const db = createClient(url, serviceKey);
  const { data: row } = await db.from('submissions').select('id').eq('id', submissionId).maybeSingle();
  if (!row) return reply({ error: 'Unknown submission' }, 404);

  // 3. Copy the recording into private storage (the AIMedicalls link expires after 30 days).
  let recordingPath: string | null = null;
  if (p.recording?.url) {
    try {
      const audio = await fetch(p.recording.url, { signal: AbortSignal.timeout(60000) });
      const bytes = new Uint8Array(await audio.arrayBuffer());
      if (audio.ok && bytes.length > 0 && bytes.length <= MAX_AUDIO_BYTES) {
        const path = `${submissionId}/${p.call_id}.mp3`;
        const up = await db.storage.from('call-recordings').upload(path, bytes, { contentType: 'audio/mpeg', upsert: true });
        if (!up.error) recordingPath = path;
        else console.error('recording upload failed', up.error.message);
      }
    } catch (e) {
      console.error('recording download failed', String(e));
    }
  }

  // 4. Save the call result.
  const { error } = await db.from('submissions').update({
    call_id: p.call_id ?? null,
    call_status: p.status ?? null,
    call_outcome: p.outcome ?? null,
    call_end_reason: p.end_reason ?? null,
    call_duration_sec: typeof p.duration_sec === 'number' ? p.duration_sec : null,
    call_summary: p.summary ?? null,
    call_transcript: p.transcript ?? null,
    call_recording_path: recordingPath,
    call_completed_at: p.ended_at ?? new Date().toISOString(),
    // CRM record built from the call (status such as QUALIFIED_CALLBACK / HUMAN_REVIEW_REQUIRED / NO_ANSWER,
    // the intake answers, which criteria were not met and notes for the human reviewer).
    call_crm_status: p.crm_status ?? null,
    call_intake: p.intake ?? null,
    call_attempt: typeof p.attempt === 'number' ? p.attempt : null,
  }).eq('id', submissionId);
  if (error) { console.error('submission update failed', error.message); return reply({ error: 'Unable to save call result' }, 500); }

  // A non-2xx makes AIMedicalls retry; recording copy failures are not retried (the link stays valid 30 days).
  return reply({ ok: true, recording_saved: recordingPath !== null });
});
