import type { JevEvaluationContext, JevInputDocument } from './context.js';
import { sameJevSource, sourceSnapshot } from '../stamps.js';
import { sourcePassages } from './source-passages.js';

export interface TopicCategoryCandidate { name: string; definition: string; origin: 'semantic_category_catalog' }
type Category = { name: string; definition: string; signals: RegExp };

/** Catalog terms nominate reusable subjects, never authorize membership or replace source-backed judgment. */
const categories: Category[] = [
  { name: 'Security', definition: 'Protecting systems, identities, information, and access: authentication, permissions, SSO, vulnerabilities, threat reviews, and security policies.',
    signals: /\b(?:security|auth(?:entication|orization)?|sso|saml|oauth|access\s+(?:control|tokens?|reviews?)|permissions?|passwords?|session\s+tokens?|identity\s+provider|vulnerabilit\w*|pen\s*test|penetration\s+test|encryption|threats?)\b|אבטח[הת]|הרשאות|אימות|أمن|مصادقة|صلاحيات/iu },
  { name: 'Pricing', definition: 'Setting or communicating what a product costs: prices, commercial tiers, subscriptions, rate cards, plan entitlements, and pricing-page copy.',
    signals: /\b(?:pricing|prices?|tiers?|subscriptions?|rate\s+cards?|(?:free|pro|enterprise|paid)\s+plans?|monetization)\b|תמחור|מחירים|מנויים|تسعير|أسعار|اشتراكات/iu },
  { name: 'Release', definition: 'Preparing, shipping, and recovering product or service releases: launch readiness, blockers, deployment, staged rollouts, production checks, and rollback procedures.',
    signals: /\b(?:releases?|launch(?:es|ing)?|deploy\w*|rollbacks?|rollouts?|redeploy\w*|launch\s+blockers?|production\s+(?:checks?|readiness))\b|השקה|פריסה|גרסאות|إطلاق|نشر\s+الإصدار/iu },
  { name: 'Engineering', definition: 'Building and maintaining technical systems: software architecture, implementation, APIs, databases, infrastructure, debugging, testing, and reliability.',
    signals: /\b(?:engineering|software|architecture|apis?|databases?|infrastructure|debug\w*|unit\s+tests?|integration\s+tests?|smoke\s+tests?|storage|technical\s+design|implementation)\b|הנדסה|ארכיטקטורה|מסד\s+נתונים|هندسة|برمجيات/iu },
  { name: 'Design', definition: 'Shaping experiences and interfaces: user experience, interaction design, visual systems, accessibility, prototypes, and design research.',
    signals: /\b(?:design|ux|ui|accessibility|prototypes?|interaction\s+design|user\s+experience|visual\s+systems?)\b|עיצוב|נגישות|تصميم|تجربة\s+المستخدم/iu },
  { name: 'Product', definition: 'Defining product value and behavior: requirements, features, user needs, product strategy, roadmaps, and product discovery.',
    signals: /\b(?:product|requirements?|features?|roadmaps?|user\s+needs|product\s+discovery)\b|מוצר|דרישות|خارطة\s+الطريق|متطلبات/iu },
  { name: 'Operations', definition: 'Running services and business processes: on-call work, incidents, operational runbooks, service health, logistics, and routine execution.',
    signals: /\b(?:operations?|operational|on[ -]call|incidents?|runbooks?|service\s+health|logistics|business\s+processes?)\b|תפעול|תקריות|عمليات|حوادث/iu },
  { name: 'Research', definition: 'Investigating questions and generating evidence: experiments, hypotheses, studies, literature reviews, methods, and research findings.',
    signals: /\b(?:research|experiments?|hypothes\w*|studies|literature\s+reviews?|research\s+findings|methodology)\b|מחקר|ניסוי|השערות|بحث|تجارب/iu },
  { name: 'Legal', definition: 'Legal rights and obligations: contracts, regulations, compliance, privacy law, licensing, and legal review.',
    signals: /\b(?:legal|contracts?|regulations?|compliance|privacy\s+law|licensing|liability)\b|משפטי|חוזים|רגולציה|قانون|عقود/iu },
  { name: 'People', definition: 'Supporting people and teams: hiring, onboarding, roles, performance, learning, workplace culture, and human resources.',
    signals: /\b(?:hiring|recruit\w*|onboarding|human\s+resources|employees?|performance\s+reviews?|workplace\s+culture|learning\s+and\s+development)\b|גיוס|עובדים|משאבי\s+אנוש|توظيف|موارد\s+بشرية/iu },
  { name: 'Marketing', definition: 'Creating awareness and demand: positioning, messaging, campaigns, public copy, brand, audience research, and promotion.',
    signals: /\b(?:marketing|campaigns?|positioning|messaging|brand|public\s+copy|promotion|audience\s+research)\b|שיווק|קמפיין|מותג|تسويق|علامة\s+تجارية/iu },
  { name: 'Sales', definition: 'Winning and managing commercial opportunities: sales processes, prospects, pipeline, deals, account plans, and buyer conversations.',
    signals: /\b(?:sales|prospects?|pipeline|deals?|account\s+plans?|buyer\s+conversations?|commercial\s+opportunities)\b|מכירות|עסקאות|مبيعات|صفقات/iu },
  { name: 'Support', definition: 'Helping customers use a product: support requests, troubleshooting, customer questions, help-center guidance, and service resolutions.',
    signals: /\b(?:support|troubleshoot\w*|help[ -]center|customer\s+questions?|support\s+tickets?|service\s+resolutions?)\b|תמיכה|מרכז\s+עזרה|دعم|مركز\s+المساعدة/iu },
  { name: 'Finance', definition: 'Managing money and financial performance: budgets, accounting, forecasts, revenue, expenses, invoices, and financial reporting.',
    signals: /\b(?:finance|financial|budgets?|accounting|forecasts?|revenue|expenses?|invoices?)\b|כספים|תקציב|חשבוניות|ميزانية|محاسبة/iu },
  { name: 'Planning', definition: 'Coordinating future work: project plans, milestones, schedules, dependencies, objectives, capacity, and prioritization.',
    signals: /\b(?:planning|project\s+plans?|milestones?|schedules?|dependencies|objectives?|capacity|prioriti[sz]ation)\b|תכנון|אבני\s+דרך|תלויות|تخطيط|مواعيد/iu },
];

function currentSource(document: JevInputDocument): boolean {
  if (!document.block.incarnation) return false;
  return sameJevSource(document.snapshot, sourceSnapshot(document.snapshot.workspaceId, document.canvasId, document.block));
}
function localSource(context: JevEvaluationContext, member: JevInputDocument, source: JevInputDocument): boolean {
  return source.canvasId === member.canvasId && source.snapshot.workspaceId === context.workspaceId
    && !source.block.archived && !source.block.processingExcluded && source.block.contentLoaded !== false;
}
function readableText(document: JevInputDocument): string {
  return sourcePassages(document.block.content).map(passage => passage.text).join(' ').normalize('NFKC').slice(0, 5000);
}
function localMentions(category: Category, text: string): number {
  return [...text.matchAll(new RegExp(category.signals.source, `${category.signals.flags}g`))].length;
}

/** Scoped readable passages nominate at most eight broad subjects; each requires local semantic evidence before indexing or filing. */
export function topicCategoryCandidates(context: JevEvaluationContext, document: JevInputDocument): TopicCategoryCandidate[] {
  if (!currentSource(document)) return [];
  const sources = context.documents.filter(source => localSource(context, document, source)).filter(currentSource);
  if (!sources.some(source => sameJevSource(source.snapshot, document.snapshot))) return [];
  const ownText = readableText(document);
  if (!ownText.trim()) return [];
  const texts = sources.map(readableText);
  return categories.map((category, index) => ({ category, index, local: localMentions(category, ownText),
    count: texts.filter(text => category.signals.test(text)).length }))
    .filter(candidate => candidate.count > 0)
    .sort((left, right) => right.local - left.local || right.count - left.count || left.index - right.index)
    .slice(0, 8).map(({ category }) => ({ name: category.name, definition: category.definition, origin: 'semantic_category_catalog' }));
}
