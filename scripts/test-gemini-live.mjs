#!/usr/bin/env node
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../');
const envPath = path.resolve(rootDir, '.env');

if (fs.existsSync(envPath)) {
  config({ path: envPath });
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

const apiKey = process.env.GEMINI_API_KEY || process.env.AI_API_KEY;
const model = process.env.GEMINI_MODEL || process.env.AI_MODEL || 'gemini-3.8-flash';
const timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS || 30000);

console.log('================================================================================');
console.log('TALENTLENS AI — GOOGLE GEMINI LIVE INTEGRATION TEST');
console.log('================================================================================');

if (
  !apiKey ||
  apiKey.trim() === '' ||
  apiKey.includes('placeholder') ||
  apiKey.includes('your_') ||
  apiKey.includes('AIzaSySynthetic')
) {
  console.log('Status: UNVERIFIED (Awaiting real user key)');
  console.log('\nNo real GEMINI_API_KEY detected.');
  console.log('To run this live integration test against Google Gemini API:');
  console.log('  1. Add your key to ./.env:');
  console.log('     GEMINI_API_KEY=AIzaSy...');
  console.log('  2. Or run with inline variable:');
  console.log('     $env:GEMINI_API_KEY="AIzaSy..."; npm run test:gemini');
  console.log('\nConfigured Model:   ' + model);
  console.log('Configured Timeout: ' + timeoutMs + 'ms');
  console.log('================================================================================');
  process.exit(0);
}

console.log(`Provider:           Google Gemini (@google/genai)`);
console.log(`Configured Model:   ${model}`);
console.log(`Request Timeout:    ${timeoutMs}ms`);
console.log('\nExecuting live Google Gemini inference verification...');

const overallStart = Date.now();

try {
  const { GoogleGenAI, Type } = await import('@google/genai');
  const ai = new GoogleGenAI({
    apiKey: apiKey.trim(),
    httpOptions: { timeout: timeoutMs },
  });

  // Step 1: Synthetic JD Extraction
  const syntheticJd =
    'Synthetic Requisition: Senior Distributed Systems Architect with PostgreSQL and Docker experience.';
  const jdPrompt = `Extract job requirements from:\n${syntheticJd}`;
  const jdStart = Date.now();

  const jdRes = await ai.models.generateContent({
    model,
    contents: jdPrompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          jobTitle: { type: Type.STRING },
          requiredSkills: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: ['jobTitle', 'requiredSkills'],
      },
    },
  });

  const jdDuration = Date.now() - jdStart;
  const jdOutputText = jdRes.text ?? '';
  JSON.parse(jdOutputText); // Validate JSON parse

  console.log('\n[1/2] Structured JD Extraction:');
  console.log(`  * Status:            SUCCESS`);
  console.log(`  * Latency:           ${jdDuration}ms`);
  console.log(`  * Prompt SHA-256:    ${sha256Hex(jdPrompt).slice(0, 16)}...`);
  console.log(`  * Output SHA-256:    ${sha256Hex(jdOutputText).slice(0, 16)}...`);
  console.log(
    `  * Token Usage:       Prompt=${jdRes.usageMetadata?.promptTokenCount ?? 'N/A'}, Candidate=${jdRes.usageMetadata?.candidatesTokenCount ?? 'N/A'}`,
  );

  // Step 2: Synthetic Candidate Assessment
  const syntheticResume =
    'Synthetic Profile: 6 years building distributed PostgreSQL databases and containerized services with Docker.';
  const assessPrompt = `Evaluate synthetic resume against requirement "PostgreSQL Architecture":\n${syntheticResume}`;
  const assessStart = Date.now();

  const assessRes = await ai.models.generateContent({
    model,
    contents: assessPrompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          status: { type: Type.STRING, enum: ['MATCH', 'PARTIAL', 'NOT_FOUND', 'UNCERTAIN'] },
          score: { type: Type.NUMBER },
          explanation: { type: Type.STRING },
          evidenceQuotes: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ['status', 'score', 'explanation', 'evidenceQuotes'],
      },
    },
  });

  const assessDuration = Date.now() - assessStart;
  const assessOutputText = assessRes.text ?? '';
  JSON.parse(assessOutputText); // Validate JSON parse

  console.log('\n[2/2] Evidence-Grounded Assessment:');
  console.log(`  * Status:            SUCCESS`);
  console.log(`  * Latency:           ${assessDuration}ms`);
  console.log(`  * Prompt SHA-256:    ${sha256Hex(assessPrompt).slice(0, 16)}...`);
  console.log(`  * Output SHA-256:    ${sha256Hex(assessOutputText).slice(0, 16)}...`);
  console.log(
    `  * Token Usage:       Prompt=${assessRes.usageMetadata?.promptTokenCount ?? 'N/A'}, Candidate=${assessRes.usageMetadata?.candidatesTokenCount ?? 'N/A'}`,
  );

  const totalDuration = Date.now() - overallStart;
  console.log('\n--------------------------------------------------------------------------------');
  console.log(`[PASS] Live Google Gemini integration verified in ${totalDuration}ms`);
  console.log('Privacy Check:        Zero candidate PII or raw responses printed to output.');
  console.log('Autonomous Decisions: PREVENTED (Suggestions and evidence quotes only)');
  console.log('================================================================================');
} catch (err) {
  const errMsg = String(err?.message || err);
  let category = 'UPSTREAM_API_ERROR';

  if (errMsg.includes('401') || errMsg.includes('403') || errMsg.includes('API key not valid')) {
    category = 'AUTH_ERROR (Invalid or unauthorized Gemini API key)';
  } else if (errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED')) {
    category = 'RATE_LIMIT_429 (Upstream Gemini quota exceeded)';
  } else if (
    errMsg.includes('ETIMEDOUT') ||
    errMsg.includes('deadline') ||
    errMsg.includes('timeout')
  ) {
    category = 'TIMEOUT (Request exceeded configured timeout threshold)';
  } else if (errMsg.includes('not found') || errMsg.includes('404')) {
    category = 'MODEL_NOT_FOUND (Model name does not exist or not available in this region)';
  }

  console.error('\n[FAIL] Live Google Gemini request failed:');
  console.error(`  * Classification:   ${category}`);
  console.error(`  * Safe Error Note:  ${errMsg.slice(0, 120)}`);
  console.log('================================================================================');
  process.exit(1);
}
