with open('app.js', 'r', encoding='utf-8') as f:
    content = f.read()

old = "if (kind === 'access') return '\u01f0\u01fc\u01c8';\nreturn '\u01c8\u01d0\u01c8';"
new = "if (kind === 'access') return '\u01f0\u01fc\u01c8';\nif (kind === 'tenant_view') return 'TV';\nreturn '\u01c8\u01d0\u01c8';"

if old in content:
    content = content.replace(old, new, 1)
    with open('app.js', 'w', encoding='utf-8') as f:
        f.write(content)
    print('Replaced')
else:
    print('Not found')
    idx = content.find("if (kind === 'access')")
    print(repr(content[idx:idx+80]))
