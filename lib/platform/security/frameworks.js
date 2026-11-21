'use strict';
// Compliance frameworks and the technical controls Starlane has built toward
// each. This is the single source for the public trust page and the admin
// Security page, so neither can say more than this file does.
//
// Ground rules (do not weaken without an actual audit report in hand):
//   * Starlane holds NO certification, attestation or authorization today.
//     `status` says so for every framework. Change it only when a signed
//     report or certificate exists, and add `evidence` naming it.
//   * Laws (GDPR, CCPA, DPDP) have no certificate. For those the honest claim
//     is "designed to align", meaning the controls listed exist in the
//     product; it is not a legal opinion.
//   * `controls` name entries in posture.js, whose live status is computed
//     from the running server, not asserted here.

const STATUS = {
  not_certified: 'Not certified',
  not_attested: 'No audit report yet',
  not_authorized: 'Not authorized',
  designed_to_align: 'Designed to align (not independently assessed)',
};

const FRAMEWORKS = [
  {
    key: 'soc2_type2', name: 'SOC 2 Type II', kind: 'attestation', status: 'not_attested',
    what: 'An independent CPA firm\'s report on whether security controls (and optionally availability, confidentiality, processing integrity, privacy) were designed well and operated effectively over a period, usually 3 to 12 months.',
    grantedBy: 'A licensed CPA firm, after an observation period.',
    controls: ['credential_encryption', 'key_rotation', 'audit_log', 'audit_tamper_evidence', 'rbac', 'approval_gates', 'tenant_isolation', 'transport_security', 'outbound_request_safety', 'retention', 'ci_security_scanning', 'incident_response_plan'],
    stillNeeded: ['Written security policies approved by management', 'Multi-factor authentication for all users and admins', 'Access reviews, onboarding and offboarding records', 'Vendor risk management', 'Backup restore tests on a schedule', 'Penetration test by a third party', 'Security awareness training records', 'A compliance automation tool or evidence process', 'Readiness assessment, then a Type I report, then a 3 to 12 month Type II observation window'],
  },
  {
    key: 'iso27001', name: 'ISO/IEC 27001', kind: 'certification', status: 'not_certified',
    what: 'The international standard for an information security management system (ISMS): a risk-driven set of policies and Annex A controls, certified by an accredited body.',
    grantedBy: 'An accredited certification body, after a Stage 1 and Stage 2 audit.',
    controls: ['credential_encryption', 'key_rotation', 'audit_log', 'audit_tamper_evidence', 'rbac', 'tenant_isolation', 'transport_security', 'outbound_request_safety', 'retention', 'ci_security_scanning', 'incident_response_plan'],
    stillNeeded: ['ISMS scope, risk assessment and risk treatment plan', 'Statement of Applicability for the Annex A controls', 'Internal audit and management review', 'Asset inventory and supplier policy', 'MFA and access review process', 'Certification audit (Stage 1 and Stage 2)'],
  },
  {
    key: 'iso27701', name: 'ISO/IEC 27701', kind: 'certification', status: 'not_certified',
    what: 'A privacy extension to ISO 27001 for organizations acting as personal data controllers or processors.',
    grantedBy: 'An accredited certification body, together with or after ISO 27001.',
    controls: ['data_export', 'data_erasure', 'retention', 'audit_log', 'rbac'],
    stillNeeded: ['ISO 27001 certification first', 'Records of processing activities', 'Data protection impact assessments', 'Processor agreements with every subprocessor', 'Privacy notice and consent records for end customers'],
  },
  {
    key: 'iso42001', name: 'ISO/IEC 42001', kind: 'certification', status: 'not_certified',
    what: 'The management system standard for AI: how an organization governs the AI it builds and uses (risk, impact assessment, human oversight, data, monitoring).',
    grantedBy: 'An accredited certification body.',
    controls: ['ai_human_oversight', 'ai_tool_risk_classes', 'ai_prompt_guard', 'ai_versioning', 'audit_log'],
    stillNeeded: ['AI policy and AI risk assessment', 'AI system impact assessments', 'Model and data provenance records', 'Monitoring of model behaviour in production', 'Certification audit'],
  },
  {
    key: 'aiuc1', name: 'AIUC-1', kind: 'certification', status: 'not_certified',
    what: 'A standard for AI agents covering security, safety, reliability, accountability, data and privacy, and societal risk, assessed by an accredited auditor with technical testing of the agent.',
    grantedBy: 'An AIUC-1 accredited auditor.',
    controls: ['ai_human_oversight', 'ai_tool_risk_classes', 'ai_prompt_guard', 'ai_versioning', 'approval_gates', 'audit_log', 'outbound_request_safety'],
    stillNeeded: ['Adversarial testing of every agent (prompt injection, data leakage, unsafe actions)', 'Documented failure handling and incident process for agents', 'Third-party technical evaluation and audit'],
  },
  {
    key: 'fedramp', name: 'FedRAMP', kind: 'authorization', status: 'not_authorized',
    what: 'The US government programme that authorizes cloud services for federal agencies, based on NIST SP 800-53 controls.',
    grantedBy: 'A US federal agency sponsor or the FedRAMP Board, after a 3PAO assessment.',
    controls: ['credential_encryption', 'audit_log', 'rbac', 'transport_security'],
    stillNeeded: ['A US federal customer or sponsor', 'Hosting on FedRAMP-authorized infrastructure in a US region', 'FIPS 140 validated cryptography', 'System Security Plan against NIST SP 800-53', 'Assessment by an accredited 3PAO', 'Continuous monitoring programme'],
    note: 'Starlane serves businesses, not US federal agencies. This is not planned.',
  },
  {
    key: 'gdpr', name: 'GDPR (EU / UK)', kind: 'law', status: 'designed_to_align',
    what: 'The EU General Data Protection Regulation (and the UK version): rights for people whose data is processed, and duties for controllers and processors.',
    grantedBy: 'No certificate exists. Compliance is assessed by regulators and by your own legal review.',
    controls: ['data_export', 'data_erasure', 'retention', 'credential_encryption', 'audit_log', 'rbac', 'tenant_isolation'],
    stillNeeded: ['A Data Processing Agreement for customers', 'A published subprocessor list', 'International transfer mechanism (SCCs) where data leaves the EU', 'Records of processing and a DPIA for the AI features', 'Erasure switched on in production after a legal retention review'],
  },
  {
    key: 'ccpa', name: 'CCPA / CPRA (California)', kind: 'law', status: 'designed_to_align',
    what: 'California\'s consumer privacy law: rights to know, delete, correct and opt out of sale or sharing.',
    grantedBy: 'No certificate exists.',
    controls: ['data_export', 'data_erasure', 'retention', 'audit_log'],
    stillNeeded: ['Service provider contract terms', 'A privacy notice covering California rights', 'A process to verify the identity of people who ask'],
  },
  {
    key: 'dpdp', name: 'India DPDP Act 2023', kind: 'law', status: 'designed_to_align',
    what: 'India\'s Digital Personal Data Protection Act: consent, purpose limitation, data principal rights and breach reporting.',
    grantedBy: 'No certificate exists.',
    controls: ['data_export', 'data_erasure', 'retention', 'audit_log', 'credential_encryption'],
    stillNeeded: ['Consent notices for end customers whose data is imported', 'A grievance officer and response process', 'Breach notification procedure to the Data Protection Board'],
  },
];

function publicFrameworks() {
  return FRAMEWORKS.map((f) => ({ ...f, statusLabel: STATUS[f.status] }));
}

module.exports = { FRAMEWORKS, STATUS, publicFrameworks };
