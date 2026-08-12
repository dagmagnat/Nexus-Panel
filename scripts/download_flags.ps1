$codes = 'ae,al,am,ar,at,au,az,ba,be,bg,bh,br,by,ca,ch,cl,cn,co,cr,cy,cz,de,dk,ee,eg,es,fi,fr,gb,ge,gr,hk,hr,hu,id,ie,il,in,iq,is,it,jo,jp,kg,kr,kw,kz,lt,lu,lv,ma,md,me,mk,mt,mx,my,ng,nl,no,nz,om,pa,pe,ph,pk,pl,pt,qa,ro,rs,ru,sa,se,sg,si,sk,th,tj,tr,tw,ua,us,uz,vn,ad,bd,bn,bo,do,dz,ec,et,ke,kh,la,li,lk,mc,mn,mo,mv,np,sm,sv,tn,uy,va,ve,xk,eu,za'.Split(',')
$dir = 'C:\Projects\3xui-Aggregator-main\public\flags'
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$fail = @()
foreach ($c in $codes) {
  $f = Join-Path $dir ($c + '.svg')
  if (-not (Test-Path $f)) {
    try {
      Invoke-WebRequest -Uri ('https://flagcdn.com/' + $c + '.svg') -OutFile $f -UseBasicParsing -TimeoutSec 25
    } catch {
      $fail += $c
    }
  }
}
Write-Host ('FAILED: ' + ($fail -join ','))
Write-Host ('TOTAL FILES: ' + (Get-ChildItem $dir -Filter *.svg).Count)
