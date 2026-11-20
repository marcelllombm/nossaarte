"""Author the measured logo contract before generating geometry (Python 3.12)."""
import copy
import json
import math
from pathlib import Path

base = Path(__file__).parent
path = base / 'logo-sculpt-spec.json'
s = json.loads(path.read_text())
if s.get('reviewHistory'):
    raise SystemExit('Initial authoring only: preserve the reviewed spec and apply explicit refinements instead.')
a = s['preSpecAssessment']
a['objectClass'].update(primaryType='four-layer circular emblem', primaryDomain='object',
    formLanguage=['hard-surface', 'calligraphic extruded profile'], structureKind=['layered shell'],
    motionPotential=['whole-object transform', 'detachable'], materialFamilies=['coated dielectric'],
    notes='Simple planar four-part assembly. Fine calligraphic outline is identity-critical; no repeated hardware or organic hierarchy.')
a['complexity'].update(scores=dict(zip(a['complexity']['scores'], [1,1,0,0,1,1,0,1])),
    estimatedCounts={'macroComponents':4,'mesoComponents':0,'microFeatureGroups':10,'materialLayers':3,'repetitionSystems':0},
    reasoning=['Four flat independent solids, shallow hierarchy; detail lives in the contour and finish, without repeated systems.'])
a['specDepthDecision']['rationale']='Four named solids with local bevel and contour features; do not invent extra assemblies.'
a['unknownsToResolveBeforeImplementation']=[]
s['suitability']='pass'
s['scores']={key: (2 if key=='depth_inference' else 3) for key in s['scores']}
s['coordinateFrame']={'front':'+Z','up':'+Y','scaleReference':'416 image pixels = 4.16 units; circular center (208,208)'}
s['assumptions']=['Stylized extruded interpretation of flat graphic, not physical reverse engineering.',
    'Navy/amber boundaries and monogram are real geometry, gradient is procedural albedo.',
    'No PBR extraction: illustration has no recoverable physical roughness; gloss explicitly requested by user.']
s['referenceCamera'].update(solved=True, positionHint=[0,0,12], projection='orthographic', orthoHeight=4.2)
s['referenceCamera']['note']='Front orthographic matches graphic with 4.2-unit review viewport.'
s['silhouette']={'boundingShape':'4.16-unit circular badge', 'aspectRatios':[1], 'symmetry':'radial rim, asymmetric monogram',
    'dominantCurves':['circular annuli','calligraphic cubic curves'], 'negativeSpaces':['monogram arch and open lower hook'],
    'landmarks':[[120,108],[197,101],[308,186],[108,256],[223,301]]}
s['viewEvidence'][0].update(observations=['Complete navy circle, inset amber band, yellow gradient disc and single navy calligraphic mark.'],confidence=1)

# Hand-authored cubic outline in reference pixels. No typeface or raster billboard.
commands=[['M',120,108],['L',120,115],['C',149,110,153,120,145,148],
    ['C',134,188,119,227,108,256],['L',152,246],['C',160,216,188,161,222,133],
    ['C',237,120,248,126,242,139],['L',223,188],['C',199,196,174,214,163,226],
    ['C',181,218,197,213,214,211],['L',195,270],['C',186,301,204,309,223,301],
    ['C',242,295,257,281,269,268],['L',263,262],['C',245,280,230,281,239,256],
    ['L',254,211],['C',269,212,284,215,298,217],['L',308,186],
    ['C',294,183,279,184,265,184],['L',283,135],['C',299,85,248,91,207,134],
    ['C',196,145,185,159,177,172],['L',173,171],['L',197,101],['L',191,97],
    ['L',173,104],['C',153,103,138,104,120,108]]
s['logoParameters']={'referenceSize':416,'unitScale':0.01,'monogramCommands':commands,
    'transitionMs':550,'maxDPR':2,'idleRotationRadians':0.035,
    'explosion':{'outer-ring':[-0.22,0.10,-1.05],'amber-ring':[-0.08,0.03,-0.35],
        'gold-core':[0.10,-0.03,0.45],'monogram':[0.23,-0.10,1.3]},
    'gradient':[[0,'#fff000'],[0.48,'#ffc000'],[1,'#ffdf00']]}

def circle(r,cy=0):
    return [[math.cos(i*math.tau/96)*r,cy+math.sin(i*math.tau/96)*r] for i in range(96)]

def sampled_outline():
    points=[]; current=None
    for c in commands:
        if c[0] in ('M','L'):
            current=c[1:]; points.append(current)
        else:
            p0=current; p1=c[1:3]; p2=c[3:5]; p3=c[5:7]
            for i in range(1,13):
                t=i/12; u=1-t
                points.append([u**3*p0[j]+3*u*u*t*p1[j]+3*u*t*t*p2[j]+t**3*p3[j] for j in (0,1)])
            current=p3
    return [[(x-208)/100,(208-y)/100] for x,y in points]

seed=copy.deepcopy(s['componentTree'][0])
root=copy.deepcopy(seed)
root.update(id='root',name='root',role='container',material='navy',materialLayers=['navy'],
    topologyRationale='Invisible unit-scale transform container; the four children own all visible solids.')
root['invisibleRoot']=True
parts=[]
for id,mat,r,inner,depth,z in [('outer-ring','navy',2.06,1.90,.27,-.20),
        ('amber-ring','amber',1.91,1.76,.24,-.10),('gold-core','gold',1.77,0,.18,.0),
        ('monogram','navy',0,0,.15,.245)]:
    c=copy.deepcopy(seed)
    c.update(id=id,name=id,parent='root',role='layer',confidence=.95,primitive='extrude',
        material=mat,materialLayers=[mat],topologyClass='assembled-solid',
        topologyRationale='Closed planar profile with inferred extrusion and edge bevel, matching requested logo relief.', fidelityTier='hero')
    c['dimensions']={'width':1,'height':1,'depth':1,'units':'relative','confidence':.95}
    c['transform']['position']=[0,0,z]
    c['geometryDescriptor'].update(topologyIntent='Closed extruded annulus' if inner else 'Closed extruded profile',
        profile2D={'points':sampled_outline() if not r else circle(r), 'holes':[circle(inner)] if inner else [], 'depth':depth},
        edgeTreatment={'type':'chamfer','bevelRadius':.012 if id=='monogram' else .022,'segments':3})
    c['actionProfile']['animationRole']='detachable-layer'
    c['actionProfile']['sockets']=[{'id':id+'-center','position':[0,0,0]}]
    c['actionProfile']['destruction'].update(breakable=True,fractureGroup=id,detachableFragments=[id],debrisMaterial=mat)
    c['seams']=['nested radial contact; gold front meets monogram back']
    parts.append(c)
s['componentTree']=[root,*parts]

details=[('rim-profile','outer-ring','bevel','19px navy band and small inferred chamfer'),
    ('amber-profile','amber-ring','bevel','amber inset annulus'),
    ('gold-profile','gold-core','bevel','circular gold disk seated inside amber'),
    ('gold-gradient','gold-core','decal','warm gold gradient'),
    ('gold-gloss','gold-core','gloss','broad upper curved satin highlight'),
    ('left-serif','monogram','linework','short upper left serif (120,108)'),
    ('italic-stem','monogram','linework','inclined stem descending to (108,256)'),
    ('inner-arch','monogram','linework','open curved negative space at (222,133)'),
    ('crossbar','monogram','linework','right crossbar ending at (308,186)'),
    ('lower-hook','monogram','linework','lower terminal curves back to (269,268)')]
a['detailInventory'].update(targetMinDetails=10,details=[])
for id,part,kind,note in details:
    component=next(c for c in parts if c['id']==part)
    component['localFeatures'].append({'id':id,'type':kind,'description':note,'evidenceRefs':['full-object'],'confidence':.95})
    a['detailInventory']['details'].append({'id':id,'kind':kind,'description':note,'mapsTo':{'ref':id},'evidenceRefs':['full-object']})

seedmat=s['materials'][0]; mats=[]
for id,color,rough,metal in [('navy','#08005e',.32,.05),('amber','#ff8900',.30,.08),('gold','#ffcf00',.27,.16)]:
    m=copy.deepcopy(seedmat)
    m.update(id=id,name=id,type='physical',shaderModel='MeshPhysicalMaterial',baseColor=color,color=color,
        clearcoat=.65,clearcoatRoughness=.24,textureResolution=512,notes='Clean illustrated enamel, no photographic surface noise.')
    m['albedo']={'dominant':color,'secondary':[color],'samplingNotes':'Visible flat graphic regions; gold procedural gradient.'}
    m['colorVariation']={'palette':[color], 'pattern':'gold-gradient' if id=='gold' else 'solid', 'amplitude':.2 if id=='gold' else 0}
    m['roughness']={'base':rough,'localResponse':'clean satin enamel'}
    m['metalness']={'base':metal,'variation':0}
    m['normal']={'pattern':'geometry-bevel-normals','strength':0,'scale':1,'space':'object'}
    m['localOverrides']=[{'id':id+'-bevel-response','region':'chamfer','roughness':rough,'evidenceRefs':['full-object']}]
    m['textureless']={'declared':True,'evidence':['img/logo.png: flat vector-style color and smooth gradient, no grain, pores, scratches or photographic surface detail.']}
    for field in ['normal','bump','displacement','surfaceFrequencyBands','textureProjection','textureResolution']:
        m.pop(field,None)
    m['shaderNotes']=['No noise or photographic PBR maps: reference is flat vector-style art. Physical response is inferred from requested gloss.']
    mats.append(m)
s['materials']=mats
for c in s['componentTree']:
    color=next(m['baseColor'] for m in mats if m['id']==c['material'])
    rgb=[int(color[i:i+2],16) for i in (1,3,5)]
    rgba=f'rgba({rgb[0]}, {rgb[1]}, {rgb[2]}, 1)'
    c['colorMaterialRecipe']={'dominantAlbedo':rgba,'secondaryAlbedo':rgba,
        'materialClass':'plastic','materialClassConfidence':.7,'evidenceRefs':['full-object']}
s['qualityContract']['definitionOfDone']=[json.loads((base/'image-analysis.json').read_text())['qualityContract']['definitionOfDone']]
s['qualityContract']['minimumSpecDepth'].update(macroComponents=4,microFeatureGroups=10,materialLayers=3,reviewViewpoints=4)
s['qualityContract']['featureGroups']=[g for g in s['qualityContract']['featureGroups'] if g['id'] in ['overall-silhouette','primary-structure','surface-material-response']]
s['qualityTargets'].update(targetFidelity=.85,reviewViewpoints=['front','right','rear','left','oblique-hover'],fpsTarget=60,
    mustMatch=['circular nested navy/amber/gold silhouette','calligraphic monogram profile','four separate closed solids'],niceToHave=['soft specular highlight'])
s['lookDevTargets']['materialPass'].update(roughnessVariationRequired=False, normalOrBumpRequired=False,
    minimumTextureResolution=512,preferredTextureResolution=512)
s['lookDevTargets']['materialPass']['referencePbrExtraction'].update(requiredWhenSourceImagePresent=False,
    acceptedLimitation='Source is a flat logo illustration, no physical PBR information. User requests an inferred satin/gloss material.')
s['featureReviewTargets']=[{'id':id,'name':name,'tier':'critical','passIds':s['sculptPipeline']['passOrder'],
    'minimumScore':.8,'mustPass':True,'componentRefs':refs,'evidenceRefs':['full-object']} for id,name,refs in [
    ('concentric-emblem','Circular navy / amber / gold nested silhouette',['outer-ring','amber-ring','gold-core']),
    ('calligraphic-monogram','Inclined stem, arch, crossbar and lower hook',['monogram'])]]
for p in s['buildPasses']: p['componentRefs']=[c['id'] for c in parts]
s['lightingFromPhoto']=['Inferred studio key (-3,5,7), ambient white, cool fill (4,-1,4), rim (-2,1,-4).',
    'Transparent background, neutral tone mapping exposure 1; soft contact shadow from monogram on core.',
    'Soft key reflection on chamfers; modest clearcoat keeps dark navy readable.']
s['performanceBudget'].update(targetTriangles=20000,maxDrawCalls=12,textureSize=512,fpsTarget=60)
s['risks']=['Physical thickness and hidden surfaces inferred. Front outline approximate from 416px source.']
path.write_text(json.dumps(s,indent=2)+'\n')
assessment=json.loads((base/'assessment.json').read_text())
assessment.update(preSpecAssessment=a,qualityContract=s['qualityContract'])
(base/'assessment.json').write_text(json.dumps(assessment,indent=2)+'\n')
