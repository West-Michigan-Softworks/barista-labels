# Research only. Creates new workspace files; never changes the installed sample or prints.
Add-Type -Path 'C:\Program Files\Seagull\BarTender 12.1\Interop.BarTender.dll'
Add-Type -ReferencedAssemblies 'C:\Program Files\Seagull\BarTender 12.1\Interop.BarTender.dll','System.Xml.dll' -TypeDefinition @'
public static class BtwProfilesResearch {
 static void Save(BarTender.Format f,string name){f.SaveAs(System.IO.Path.GetFullPath("research-artifacts/btw/mail-"+name+".btw"),true);}
 public static void Make() {
  var app=new BarTender.ApplicationClass();
  try {
   var f=app.Formats.Open(@"C:\Program Files\Seagull\BarTender 12.1\Templates\Shipping\USPS\POSTFIMA.BTW",false,"");
   BarTender.DesignObject box=null,text=null;var remove=new System.Collections.Generic.List<string>();
   foreach(BarTender.DesignObject o in f.Objects){System.Console.WriteLine(o.Name+" "+o.Type);if(o.Type==BarTender.BtObjectType.btObjectBox)box=o;else if(o.Type==BarTender.BtObjectType.btObjectText && o.Value.Contains("PLACE STAMP"))text=o;else remove.Add(o.Name);}
   foreach(var name in remove)f.Objects.Delete(name);
   System.Console.WriteLine("Opened source and removed shape");
   f.PageSetup.LabelSizeManual=true;f.PageSetup.LabelWidth=4;f.PageSetup.LabelHeight=2;
   System.Console.WriteLine("Dimensions set");
   box.X=1;box.Y=.25;box.Width=1;box.Height=.5;box.LineThickness=.01;box.RotationAngle=0;
   System.Console.WriteLine("Box geometry set");
   text.X=2;text.Y=1;text.FontName="Arial";text.FontSize=12;text.FontWeight=BarTender.BtFontWeight.btFontWeightNormal;text.FontItalic=false;text.FontUnderline=false;text.RotationAngle=0;
   text.Width=2;
   System.Console.WriteLine("Text font set");
   var xml=new System.Xml.XmlDocument();xml.LoadXml(f.Objects.ExportDataSourceValuesToXML());
   var value=xml.SelectSingleNode("/Command/DataMerge/Object[@Name='"+text.Name+"']/SubString/Value");
   value.InnerText=System.Convert.ToBase64String(System.Text.Encoding.Unicode.GetBytes("Hello world"));
   System.Console.WriteLine("Import text "+f.Objects.ImportDataSourceValuesFromXML(xml.OuterXml));
   System.Console.WriteLine("Text "+text.Value+" font "+text.FontName+" "+text.FontSize+" weight "+text.FontWeight+" width "+text.Width+" height "+text.Height);
   Save(f,"core");
   box.X=1.5;Save(f,"core-box-x");box.X=1;
   box.Y=.5;Save(f,"core-box-y");box.Y=.25;
   box.Width=1.5;Save(f,"core-box-width");box.Width=1;
   box.Height=.75;Save(f,"core-box-height");box.Height=.5;
   box.RotationAngle=90;Save(f,"core-box-rotation");box.RotationAngle=0;
   box.LineThickness=.02;Save(f,"core-box-stroke");box.LineThickness=.01;
   text.X=2.5;Save(f,"core-text-x");text.X=2;
   text.Y=1.25;Save(f,"core-text-y");text.Y=1;
   text.FontSize=24;Save(f,"core-text-size");text.FontSize=12;
   value.InnerText=System.Convert.ToBase64String(System.Text.Encoding.Unicode.GetBytes("Changed label"));f.Objects.ImportDataSourceValuesFromXML(xml.OuterXml);Save(f,"core-text-value");
   System.Console.WriteLine("Label "+f.PageSetup.LabelWidth+"x"+f.PageSetup.LabelHeight);
  }finally{app.Quit(BarTender.BtSaveOptions.btDoNotSaveChanges);}
 }
}
'@
[BtwProfilesResearch]::Make()
