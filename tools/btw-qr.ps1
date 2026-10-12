Add-Type -Path 'C:\Program Files\Seagull\BarTender 12.1\Interop.BarTender.dll'
Add-Type -ReferencedAssemblies 'C:\Program Files\Seagull\BarTender 12.1\Interop.BarTender.dll','System.Xml.dll' -TypeDefinition @'
public static class BtwQrResearch {
 public static void Make() {
  var app=new BarTender.ApplicationClass();
  try {
   var f=app.Formats.Open(@"C:\Program Files\Seagull\BarTender 12.1\Templates\Life Sciences\Levata_Locations.btw",false,"");
   BarTender.DesignObject barcode=null;var remove=new System.Collections.Generic.List<string>();
   foreach(BarTender.DesignObject o in f.Objects){System.Console.WriteLine(o.Name+" "+o.Type);if(barcode==null && o.Type==BarTender.BtObjectType.btObjectBarcode)barcode=o;else remove.Add(o.Name);}
   foreach(var name in remove)f.Objects.Delete(name);
   f.PageSetup.LabelSizeManual=true;f.PageSetup.LabelWidth=4;f.PageSetup.LabelHeight=2;
   barcode.X=.5;barcode.Y=.5;
   var xml=new System.Xml.XmlDocument();xml.LoadXml(f.Objects.ExportDataSourceValuesToXML());
   System.Console.WriteLine(xml.OuterXml);
   var value=xml.SelectSingleNode("/Command/DataMerge/Object[@Name='"+barcode.Name+"']/SubString/Value");
   value.InnerText=System.Convert.ToBase64String(System.Text.Encoding.Unicode.GetBytes("BARISTA-QR-01"));f.Objects.ImportDataSourceValuesFromXML(xml.OuterXml);
   f.SaveAs(System.IO.Path.GetFullPath("research-artifacts/btw/qr-only.btw"),true);
   System.Console.WriteLine("QR X="+barcode.X+" Y="+barcode.Y+" value="+barcode.Value);
   barcode.ExportToFile(System.IO.Path.GetFullPath("research-artifacts/btw/qr-only-object.png"),"PNG",BarTender.BtColors.btColorsMono,BarTender.BtResolution.btResolutionPrinter,BarTender.BtSaveOptions.btDoNotSaveChanges);
   value.InnerText=System.Convert.ToBase64String(System.Text.Encoding.Unicode.GetBytes("BARISTA-QR-02"));f.Objects.ImportDataSourceValuesFromXML(xml.OuterXml);f.SaveAs(System.IO.Path.GetFullPath("research-artifacts/btw/qr-value.btw"),true);
  }finally{app.Quit(BarTender.BtSaveOptions.btDoNotSaveChanges);}
 }
}
'@
[BtwQrResearch]::Make()
