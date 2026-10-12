Add-Type -Path 'C:\Program Files\Seagull\BarTender 12.1\Interop.BarTender.dll'
Add-Type -ReferencedAssemblies 'C:\Program Files\Seagull\BarTender 12.1\Interop.BarTender.dll' -TypeDefinition @'
public static class BtwImageResearch {
 public static void Make() {
  var app=new BarTender.ApplicationClass();
  try {
   var f=app.Formats.Open(@"C:\Program Files\Seagull\BarTender 12.1\Templates\Signage\No Smoking\No Smoking 4 x 4 - Version 1.btw",false,"");
   BarTender.DesignObject picture=null;var remove=new System.Collections.Generic.List<string>();
   foreach(BarTender.DesignObject o in f.Objects){System.Console.WriteLine(o.Name+" "+o.Type);if(picture==null && o.Type==BarTender.BtObjectType.btObjectPicture)picture=o;else remove.Add(o.Name);}
   foreach(var name in remove)f.Objects.Delete(name);
   f.PageSetup.LabelSizeManual=true;f.PageSetup.LabelWidth=4;f.PageSetup.LabelHeight=2;
   picture.PicturePath=System.IO.Path.GetFullPath("research-artifacts/btw/original-checker.png");
   picture.PreserveAspectRatio=false;picture.Width=1;picture.Height=1;picture.X=1;picture.Y=.5;picture.RotationAngle=0;
   f.SaveAs(System.IO.Path.GetFullPath("research-artifacts/btw/image-only.btw"),true);
   System.Console.WriteLine("Image X="+picture.X+" Y="+picture.Y+" W="+picture.Width+" H="+picture.Height+" path="+picture.PicturePath);
   picture.ExportToFile(System.IO.Path.GetFullPath("research-artifacts/btw/image-only-object.png"),"PNG",BarTender.BtColors.btColorsMono,BarTender.BtResolution.btResolutionPrinter,BarTender.BtSaveOptions.btDoNotSaveChanges);
   picture.X=1.5;f.SaveAs(System.IO.Path.GetFullPath("research-artifacts/btw/image-moved.btw"),true);
  }finally{app.Quit(BarTender.BtSaveOptions.btDoNotSaveChanges);}
 }
}
'@
[BtwImageResearch]::Make()
