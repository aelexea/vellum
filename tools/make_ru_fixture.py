#!/usr/bin/env python3
"""Build testbooks/ru_fixture.epub — a small genuine Russian EPUB 2 book used at
integration to verify Cyrillic import, TOC, FTS indexing and search end-to-end
(Gutenberg's "Russian" section turned out to be English translations)."""
import zipfile, os, uuid

OUT = os.path.join(os.path.dirname(__file__), "..", "testbooks", "ru_fixture.epub")
UID = "vellum-ru-fixture-0001"

CHAPTERS = [
    ("ch1.xhtml", "Глава первая", """
<p>Однажды осенью московский купец Семён Иванович Погодин отправился в Нижний Новгород
на ярмарку. Дорога была дальняя, а погода стояла ветреная и холодная. Купец вёз с собой
товар: сукно, самовар и несколько пудов мёду.</p>
<p>В пути его застала метель. Ямщик предложил переждать непогоду в деревне, но Семён
Иванович торопился — ярмарка открывалась через два дня, а место на торговом ряду нужно
было занять заранее.</p>
<p>К вечеру путники добрались до постоялого двора. Хозяин встретил их хлебом и солью,
натопил баню и рассказал, что на ярмарке ожидается небывалый съезд купечества.</p>"""),
    ("ch2.xhtml", "Глава вторая", """
<p>На другой день метель улеглась, и путники продолжили путь. По обеим сторонам дороги
тянулись берёзовые рощи, покрытые инеем. Солнце всходило над Волгой, и река сверкала,
словно расплавленное серебро.</p>
<p>Семён Иванович думал о своём деле. Мёд он рассчитывал продать монастырям, сукно —
городским лавкам, а самовар оставить в подарок нижегородскому знакомцу. Мысли его были
просты и деловиты, как у всякого человека, привыкшего считать копейку.</p>
<p>К полудню вдали показались золотые купола соборов. Ярмарка встречала путников гулом
колоколов и многолюдьем. Начиналась большая торговля.</p>"""),
    ("ch3.xhtml", "Глава третья", """
<p>Торговля шла успешно. Мёд у купца взяли два монастыря, сукно разошлось по лавкам
за неделю, а самовар пришёлся знакомцу по душе. Семён Иванович выручил хорошую прибыль
и остался доволен поездкой.</p>
<p>Перед отъездом он купил домой гостинцев: пряников печатных, баранок и леденцов для
детей. Ярмарка шумела вокруг, гремела музыка, и казалось, что этому празднику не будет
конца.</p>
<p>Домой купец возвращался уже зимой, по крепкому санному пути. Метель его больше не
пугала: дело было сделано, а впереди ждал тёплый дом и семейный чай с покупными
гостинцами.</p>"""),
]

MIMETYPE = "application/epub+zip"
CONTAINER = """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"""

OPF = """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>Нижегородская ярмарка</dc:title>
    <dc:creator opf:role="aut">Семён Погодин</dc:creator>
    <dc:language>ru</dc:language>
    <dc:identifier id="BookId">urn:uuid:%s</dc:identifier>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    %s
  </manifest>
  <spine toc="ncx">%s</spine>
</package>"""

NCX = """<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:%s"/></head>
  <docTitle><text>Нижегородская ярмарка</text></docTitle>
  <navMap>%s</navMap>
</ncx>"""

PAGE = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ru"><head><title>%s</title></head>
<body><h1>%s</h1>%s</body></html>"""

manifest_items, spine_refs, nav_points = [], [], []
for i, (fn, title, body) in enumerate(CHAPTERS, 1):
    manifest_items.append(f'<item id="ch{i}" href="{fn}" media-type="application/xhtml+xml"/>')
    spine_refs.append(f'<itemref idref="ch{i}"/>')
    nav_points.append(
        f'<navPoint id="np{i}" playOrder="{i}"><navLabel><text>{title}</text></navLabel>'
        f'<content src="{fn}"/></navPoint>')

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with zipfile.ZipFile(OUT, "w") as z:
    z.writestr("mimetype", MIMETYPE, compress_type=zipfile.ZIP_STORED)
    z.writestr("META-INF/container.xml", CONTAINER)
    z.writestr("OEBPS/content.opf", OPF % (UID, "\n    ".join(manifest_items), "".join(spine_refs)))
    z.writestr("OEBPS/toc.ncx", NCX % (UID, "\n    ".join(nav_points)))
    for fn, title, body in CHAPTERS:
        z.writestr("OEBPS/" + fn, PAGE % (title, title, body))
print("wrote", os.path.abspath(OUT), os.path.getsize(OUT), "bytes")
