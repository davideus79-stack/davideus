from PIL import Image, ImageDraw, ImageFilter, ImageFont
import math
S=1024
OUT='/home/claude/myhome-pc/icon-options/'
def grad(c1,c2,angle=135):
    img=Image.new('RGB',(S,S)); px=img.load()
    a=math.radians(angle); dx,dy=math.cos(a),math.sin(a)
    for y in range(S):
        for x in range(0,S):
            t=((x-S/2)*dx+(y-S/2)*dy)/(S*0.72)+0.5; t=max(0,min(1,t))
            px[x,y]=tuple(int(c1[i]+(c2[i]-c1[i])*t) for i in range(3))
    return img
def rgb(h): h=h.lstrip('#'); return tuple(int(h[i:i+2],16) for i in (0,2,4))
def shadow(base, shape_fn, off=(0,24), blur=40, alpha=90):
    m=Image.new('L',(S,S),0); shape_fn(ImageDraw.Draw(m),255)
    m=m.filter(ImageFilter.GaussianBlur(blur))
    sh=Image.new('RGBA',(S,S),(0,0,0,0)); sh.putalpha(m.point(lambda v:v*alpha//255))
    base.paste(Image.new('RGB',(S,S),(10,10,40)),off,sh)
def font(sz):
    for f in ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf']:
        try: return ImageFont.truetype(f,sz)
        except: pass
W=(255,255,255)

# 1 Casa sincronizzata: casa bianca con frecce di sync
def i1():
    im=grad(rgb('#4f8cff'),rgb('#7b5cf6'))
    house=lambda d,f: d.polygon([(512,250),(800,480),(800,780),(224,780),(224,480)],fill=f)
    shadow(im,house); d=ImageDraw.Draw(im)
    d.rounded_rectangle([224,470,800,790],60,fill=W)
    d.polygon([(512,230),(840,500),(184,500)],fill=W)
    d.rounded_rectangle([184,470,840,520],25,fill=W)
    col=rgb('#6a74f8')
    d.polygon([(545,540),(445,660),(510,660),(470,760),(590,620),(522,620),(565,540)],fill=col)
    return im
# 2 Telefono e PC collegati da un lampo
def i2():
    im=grad(rgb('#0b1630'),rgb('#1b2a5a'),160); d=ImageDraw.Draw(im)
    glow=Image.new('L',(S,S),0); g=ImageDraw.Draw(glow); g.ellipse([262,262,762,762],fill=255)
    glow=glow.filter(ImageFilter.GaussianBlur(120))
    im.paste(Image.new('RGB',(S,S),rgb('#22d3ee')),(0,0),glow.point(lambda v:v*60//255)); d=ImageDraw.Draw(im)
    d.rounded_rectangle([130,330,330,710],44,outline=W,width=28)
    d.rounded_rectangle([200,362,260,378],8,fill=W)
    d.rounded_rectangle([560,380,880,610],28,outline=W,width=28)
    d.rounded_rectangle([515,630,925,676],23,fill=W)
    bolt=[(470,330),(380,540),(450,540),(405,700),(540,480),(470,480),(530,330)]
    d.polygon([(x,y) for x,y in bolt],fill=rgb('#facc15'))
    return im
# 3 Monogramma M
def i3():
    im=grad(rgb('#ff7a59'),rgb('#ff3d8b')); d=ImageDraw.Draw(im)
    pts=[(230,770),(230,280),(330,280),(512,560),(694,280),(794,280),(794,770),(690,770),(690,460),(540,690),(484,690),(334,460),(334,770)]
    shadow(im,lambda dd,f: dd.polygon(pts,fill=f)); d=ImageDraw.Draw(im)
    d.polygon(pts,fill=W)
    d.ellipse([740,180,860,300],fill=rgb('#ffe066'))
    return im
# 4 Cartella con scintilla
def i4():
    im=grad(rgb('#2a1b5c'),rgb('#5b2a86'),150)
    folder=lambda d,f:(d.rounded_rectangle([190,330,834,770],70,fill=f))
    shadow(im,folder,blur=50,alpha=140); d=ImageDraw.Draw(im)
    d.rounded_rectangle([190,280,480,400],50,fill=rgb('#f59e0b'))
    d.rounded_rectangle([190,330,834,770],70,fill=rgb('#f59e0b'))
    d.rounded_rectangle([190,400,834,770],70,fill=rgb('#fbbf24'))
    def star(cx,cy,r,col):
        pts=[]
        for k in range(8):
            rr=r if k%2==0 else r*0.28; a=math.radians(k*45-90)
            pts.append((cx+rr*math.cos(a),cy+rr*math.sin(a)))
        d.polygon(pts,fill=col)
    star(512,585,140,W); star(740,250,70,rgb('#fde68a')); star(290,190,40,rgb('#fde68a'))
    return im
# 5 Aeroplanino di carta (invio istantaneo)
def i5():
    im=grad(rgb('#06b6d4'),rgb('#3b82f6'))
    plane=[(200,520),(830,230),(640,820),(520,610)]
    shadow(im,lambda dd,f: dd.polygon(plane,fill=f)); d=ImageDraw.Draw(im)
    d.polygon([(200,520),(830,230),(520,610)],fill=W)
    d.polygon([(830,230),(640,820),(520,610)],fill=rgb('#e0f2fe'))
    d.polygon([(830,230),(520,610),(560,760),(600,640)],fill=rgb('#bae6fd'))
    for k,(x,y) in enumerate([(170,700),(250,780),(330,860)]):
        d.rounded_rectangle([x-60,y-14,x+60,y+14],14,fill=(255,255,255))
    return im
# 6 Nota con onda: foglio e cerchio colorati stile Vivace
def i6():
    im=Image.new('RGB',(S,S),rgb('#f2f5fb')); d=ImageDraw.Draw(im)
    tiles=[('#3b7ff5',(150,150,500,500)),('#f39a1f',(524,150,874,500)),('#34b36a',(150,524,500,874)),('#8b5cf6',(524,524,874,874))]
    for c,b in tiles: d.rounded_rectangle(b,70,fill=rgb(c))
    d.rounded_rectangle([250,240,400,410],22,fill=W); 
    for yy in (290,330,370): d.rounded_rectangle([280,yy-8,370,yy+8],8,fill=rgb('#3b7ff5'))
    d.ellipse([629,255,769,395],outline=W,width=26); d.polygon([(690,290),(690,360),(740,325)],fill=W)
    d.rounded_rectangle([250,620,400,780],18,outline=W,width=24); d.ellipse([275,645,325,695],fill=W); d.polygon([(260,770),(320,700),(390,770)],fill=W)
    d.polygon([(699,600),(610,700),(788,700)],fill=W); d.rounded_rectangle([668,690,730,800],14,fill=W)
    return im
for n,f in enumerate([i1,i2,i3,i4,i5,i6],1):
    img=f()
    img.resize((512,512),Image.LANCZOS).save(OUT+f'opt{n}-512.png')
print('ok')
