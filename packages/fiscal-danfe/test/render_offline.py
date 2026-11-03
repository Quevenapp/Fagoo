"""QA only: convert the exact synthetic HTML to PDF without fetching any resource."""
import json
from pathlib import Path
from weasyprint import HTML

base = Path('/artifacts')
output = base / 'output' / 'pdf'
output.mkdir(parents=True, exist_ok=True)
attempts = []

def reject_resource(url, *args, **kwargs):
    attempts.append(url)
    raise ValueError('External resources are forbidden in print QA')

manifest = json.loads((base / 'manifest.json').read_text())
results = []
for source in manifest:
    name = Path(source['path']).name
    assert name.startswith('preview-') and name.endswith('.html') and source['synthetic'] is True
    document = HTML(string=(base / name).read_text(), url_fetcher=reject_resource).render()
    assert not attempts, 'The printable artifact attempted a resource load'
    if source['page_count'] is not None:
        assert len(document.pages) == source['page_count'], (name, len(document.pages), source['page_count'])
    destination = output / name.replace('.html', '.pdf')
    document.write_pdf(destination)
    results.append({'file': destination.name, 'pages': len(document.pages), 'external_resources': len(attempts)})
(output / 'qa-result.json').write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps(results))
