// Rates are independently available before the longer coherence window fills.
export function renderLiveRates(root, hr, breathing) {
  root.getElementById('heartRate').textContent=Number.isFinite(hr)?String(Math.round(hr)):'--';
  root.getElementById('breathRate').textContent=Number.isFinite(breathing)?breathing.toFixed(1):'--';
}
