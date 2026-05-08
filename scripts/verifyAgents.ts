import 'dotenv/config';
import { rootAgent as orchestrator }       from '../orchestrator/agent.js';
import { rootAgent as healthMemory }        from '../health_memory_agent/agent.js';
import { rootAgent as diagnosis }           from '../diagnosis_agent/agent.js';
import { rootAgent as intake }              from '../intake_agent/agent.js';
import { rootAgent as careNavigator }       from '../care_navigator_agent/agent.js';
import { rootAgent as socialBarrier }       from '../social_barrier_agent/agent.js';
import { rootAgent as treatmentPlanner }    from '../treatment_planner_agent/agent.js';
import { rootAgent as insuranceBilling }    from '../insurance_billing_agent/agent.js';
import { rootAgent as followupAdherence }   from '../followup_adherence_agent/agent.js';

const all = [orchestrator, healthMemory, diagnosis, intake, careNavigator, socialBarrier, treatmentPlanner, insuranceBilling, followupAdherence];
console.log('\nAgent load verification:');
for (const a of all) {
    console.log(`  ✓  ${a.name.padEnd(32)} tools=${a.tools?.length ?? 0}`);
}
console.log(`\nOrchestrator tool registry (${orchestrator.tools?.length} tools):`);
for (const t of (orchestrator.tools ?? [])) {
    console.log(`       • ${t.name}`);
}
console.log('\nAll agents loaded OK.\n');
