"""Run evidence gates, then record a separately inspected visual review."""
import json
from pathlib import Path
import subprocess
import sys
root=Path('.agents/skills/img2threejs/forge')
spec='.img2threejs/logo-sculpt-spec.json'
state='.img2threejs/state.json'
mode,p=sys.argv[1:3]
d=Path('.img2threejs/evidence')/p
def run(script,*args,report=None):
    result=subprocess.run([sys.executable,str(root/script),*map(str,args)],capture_output=True,text=True)
    if report: (d/report).write_text(result.stdout+result.stderr)
    if result.returncode:
        print(result.stdout,result.stderr); raise SystemExit(result.returncode)
    return result.stdout
def mark(*steps,evidence):
    completed={entry['id'] for entry in json.loads(Path(state).read_text())['checklist'] if entry['status']=='done'}
    pending=[step for step in steps if step not in completed]
    if pending: run('state.py','mark',*pending,'--state',state,'--evidence',evidence)
if mode=='prepare':
    run('next.py','--state',state,spec)
    mark('build-current-pass',evidence='js/logo-model.js')
    mark('render-capture',evidence=d/'front.png')
    mark('review-contract-read',evidence=root.parent/'grimoire/review/gates_reference.md')
    args=['--reference','img/logo.png','--render',d/'front.png','--spec',spec,'--pass-id',p,'--in-place']
    if p=='blockout': args+=['--map-stripped-render',d/'front.png']
    run('stage4_review/diagnose_render.py',*args,report='tier1.json')
    mark('tier1-diagnostics',evidence=d/'tier1.json')
    run('stage4_review/diagnose_render_multi_angle.py','--reference',d/'front.png','--orbit',d/'oblique.png','--orbit',d/'oblique-left.png','--json',report='multi-angle.json')
    # Expected side/front area is ~0.1 for a shallow badge, unlike a volumetric character.
    run('stage4_review/turntable_gate.py',*[arg for deg,name in [(0,'front'),(90,'right'),(180,'rear'),(270,'left')] for arg in ['--capture',f'{deg}={d/name}.png']], '--collapse-ratio','.08','--json',report='turntable.json')
    run('stage4_review/attachment_anchor.py',spec,'--json',report='attachments.json')
    run('stage4_review/interior_difference.py','img/logo.png',d/'front.png','--json',report='interior.json')
    mark('multi-angle-review',evidence=d/'multi-angle.json')
    run('stage3_build/orchestrate_passes.py','check',spec,'--pass-id',p,report='pass-gate.txt')
    mark('pass-gate-check',evidence=d/'pass-gate.txt')
    run('stage4_review/make_comparison_sheet.py','--reference','img/logo.png','--render',d/'front.png','--out',d/'comparison.png','--json')
    print(d/'comparison.png')
elif mode=='accept':
    score=float(sys.argv[3]); summary=sys.argv[4]
    layers=dict(zip(['silhouetteProportion','componentStructure','formDetail','materialSurface','lightingCamera'],map(float,sys.argv[5].split(','))))
    features=[{'id':id,'score':score,'visible':True,'notes':summary} for id in ['concentric-emblem','calligraphic-monogram']]
    (d/'feature-review.json').write_text(json.dumps(features))
    args=[spec,'--pass-id',p,'--fidelity',score,'--action','continue','--summary',summary,
          '--render-screenshot',d/'front.png','--comparison-image',d/'comparison.png','--ai-vision-score',score,
          '--layer-scores-json',json.dumps(layers),'--feature-reviews-json',d/'feature-review.json','--in-place']
    if p=='blockout': args+=['--map-stripped-render',d/'front.png']
    print(run('stage4_review/append_review.py',*args))
    mark('ai-review-recorded',evidence=d/'comparison.png')
    run('stage3_build/orchestrate_passes.py','sync',spec,'--in-place')
    mark('pipeline-sync',evidence=spec)
    print(run('next.py','--state',state,spec))
