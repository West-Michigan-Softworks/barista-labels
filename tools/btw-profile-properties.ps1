Add-Type -Path 'C:\Program Files\Seagull\BarTender 12.1\Interop.BarTender.dll'
Add-Type -ReferencedAssemblies 'C:\Program Files\Seagull\BarTender 12.1\Interop.BarTender.dll' -TypeDefinition @'
public static class BtwProfileProperties {
 public static void Read() {
  var app=new BarTender.ApplicationClass();
  try {
   var f=app.Formats.Open(System.IO.Path.GetFullPath("research-artifacts/btw/mail-core.btw"),false,"");
   foreach(BarTender.DesignObject o in f.Objects) {
    System.Console.WriteLine(o.Name+" type="+o.Type+" X="+o.X+" Y="+o.Y+" W="+o.Width+" H="+o.Height);
    if(o.Type==BarTender.BtObjectType.btObjectBox) {
     try{System.Console.WriteLine("LineColor="+o.LineColor);}catch(System.Exception e){System.Console.WriteLine(e.Message);}
     try{System.Console.WriteLine("FillColor="+o.FillColor);}catch(System.Exception e){System.Console.WriteLine(e.Message);}
    }
   }
  } finally {app.Quit(BarTender.BtSaveOptions.btDoNotSaveChanges);}
 }
}
'@
[BtwProfileProperties]::Read()
