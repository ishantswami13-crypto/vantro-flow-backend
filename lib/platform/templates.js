'use strict';
// Starter agent definitions. Each is an ordinary definition run by the same
// engine as any agent a person writes; none has code of its own. A template
// that names a planned tool (email, CRM) is labelled with what is missing and
// cannot be activated until that tool exists or is removed from the agent.

const TEMPLATES = [
  {
    key: 'sales_qualification',
    category: 'Sales',
    definition: {
      name: 'Lead qualification',
      description: 'Qualifies an inbound lead against your product catalog and proposes the next step.',
      objective: 'Given a lead (company, contact, what they asked for), decide whether it fits our offering, find the relevant products or services in our knowledge, and propose a reply and next step for a person to send.',
      instructions: 'Search knowledge for the products, pricing and qualification criteria that match the request. Score fit as strong, possible or poor with the reasons. Draft a short reply a salesperson could send. Never promise prices or terms that are not in the knowledge you found; quote them with their citation. Create a follow-up task for strong and possible leads.',
      expected_outputs: ['Fit score with reasons', 'Matching products with citations', 'Draft reply', 'Follow-up task for qualified leads'],
      success_criteria: ['Every price or claim has a citation', 'A task exists for each qualified lead'],
      tools: [{ key: 'knowledge.search' }, { key: 'knowledge.read_document' }, { key: 'tasks.create' }, { key: 'email.send' }],
      triggers: [{ type: 'manual' }, { type: 'webhook' }],
      input_schema: { fields: [{ name: 'lead', type: 'text', required: true, description: 'The lead or enquiry text' }] },
      output_schema: { fields: [{ name: 'fit', type: 'text' }, { name: 'reasons', type: 'text' }, { name: 'draft_reply', type: 'text' }] },
    },
  },
  {
    key: 'finance_analysis',
    category: 'Finance',
    definition: {
      name: 'Receivables analyst',
      description: 'Explains where cash is stuck in receivables and who to chase first.',
      objective: 'Summarize open and overdue receivables, name the customers to follow up first and why, and flag anything that needs an owner decision.',
      instructions: 'Use the receivables summary for figures; never estimate or invent an amount. If the ledger is empty say so. Rank customers by overdue amount and age. Keep the answer under 250 words.',
      expected_outputs: ['Outstanding and overdue totals', 'Ranked follow-up list', 'Decisions for the owner'],
      success_criteria: ['Every figure comes from the ledger tool output'],
      tools: [{ key: 'finance.receivables_summary' }, { key: 'knowledge.search' }, { key: 'notifications.notify' }],
      triggers: [{ type: 'manual' }, { type: 'schedule', every: 'week', weekday: 'mon', at_hour: 8 }],
    },
  },
  {
    key: 'document_research',
    category: 'Research',
    definition: {
      name: 'Document research',
      description: 'Answers a question from your documents, with citations.',
      objective: 'Answer the question asked using only the organization\'s knowledge collections, quoting the passages relied on and naming any gaps.',
      instructions: 'Search with several phrasings before concluding nothing is there. Read the most relevant documents. Cite every claim as (document, part). If the documents do not answer the question, say exactly that.',
      expected_outputs: ['Answer', 'Citations', 'Open questions'],
      success_criteria: ['No claim without a citation'],
      tools: [{ key: 'knowledge.search' }, { key: 'knowledge.read_document' }],
      triggers: [{ type: 'manual' }],
      input_schema: { fields: [{ name: 'question', type: 'text', required: true, description: 'What to research' }] },
    },
  },
  {
    key: 'procurement_review',
    category: 'Procurement',
    definition: {
      name: 'Supplier bill review',
      description: 'Reviews supplier bills due soon against your purchasing policy.',
      objective: 'List supplier bills due in the next two weeks, check them against the purchasing policy in knowledge, and create a task for any bill that needs a person to look at it.',
      instructions: 'Use the bills-due tool for amounts and dates. Search knowledge for the purchasing or approval policy. Flag bills over policy limits or from suppliers the policy names. Do not pay or schedule anything.',
      expected_outputs: ['Bills due with totals', 'Policy exceptions', 'Tasks for exceptions'],
      success_criteria: ['Each exception cites the policy passage'],
      tools: [{ key: 'procurement.bills_due' }, { key: 'knowledge.search' }, { key: 'tasks.create' }],
      triggers: [{ type: 'manual' }, { type: 'schedule', every: 'week', weekday: 'thu', at_hour: 9 }],
    },
  },
  {
    key: 'operations_monitoring',
    category: 'Operations',
    definition: {
      name: 'Operations monitor',
      description: 'Checks a system you connect on a schedule and raises a task when something is off.',
      objective: 'On each run, call the connected status endpoint, compare what it returns with the thresholds in the instructions, and notify the requester and open a task when a threshold is crossed.',
      instructions: 'Call the API connection with GET on the status path given in the run instruction. Thresholds: describe them here before activating. Report what you checked and the values you saw. Each call waits for approval.',
      expected_outputs: ['Checked values', 'Threshold breaches', 'Task for each breach'],
      success_criteria: ['A breach always produces a task'],
      tools: [{ key: 'connections.http_request' }, { key: 'notifications.notify' }, { key: 'tasks.create' }],
      triggers: [{ type: 'manual' }, { type: 'schedule', every: 'hour' }],
    },
  },
  {
    key: 'executive_briefing',
    category: 'Leadership',
    definition: {
      name: 'Executive briefing',
      description: 'A short weekly brief from your knowledge and, if Finance is enabled, receivables.',
      objective: 'Write a one-page briefing for leadership: what changed, what needs a decision, and what is at risk, from the organization\'s own knowledge and data.',
      instructions: 'Search knowledge for recent updates, reports and decisions. If the receivables tool is granted, include the cash position from it. Separate facts (with citations) from your recommendations. Notify the requester when the brief is ready.',
      expected_outputs: ['What changed', 'Decisions needed', 'Risks', 'Citations'],
      success_criteria: ['Facts and recommendations are kept separate'],
      tools: [{ key: 'knowledge.search' }, { key: 'knowledge.read_document' }, { key: 'notifications.notify' }],
      triggers: [{ type: 'manual' }, { type: 'schedule', every: 'week', weekday: 'mon', at_hour: 7 }],
    },
  },
];

function listTemplates(describeTool) {
  return TEMPLATES.map((t) => {
    const missing = t.definition.tools
      .map((x) => describeTool(x.key))
      .filter((d) => d && d.status !== 'available')
      .map((d) => ({ tool: d.key, name: d.name, status: d.status, reason: d.reason }));
    return { key: t.key, category: t.category, name: t.definition.name, description: t.definition.description, definition: t.definition, missing, ready: missing.length === 0 };
  });
}

function getTemplate(key) {
  return TEMPLATES.find((t) => t.key === key) || null;
}

module.exports = { TEMPLATES, listTemplates, getTemplate };
