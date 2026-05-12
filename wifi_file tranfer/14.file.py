# 文件写入
with open('/sdcard/yahboom.txt', 'w') as f:
    f.write("Hello Yahboom")

# 文件读取
with open('/sdcard/yahboom.txt', 'r') as f:
    print(f.read())
