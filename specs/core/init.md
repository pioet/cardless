usage: cardless init <project-name: eg. coup> or ./

创建一个游戏配置文件，并生成必要的配置文件。参照示例：games/landlord 

game.toml 总配置。包含游戏名、配置版本、可选编辑者信息和最多玩家数量。
`editor` 是游戏配置的编辑者或维护者，不代表桌游原作者；`comment` 可记录一段简短留言或项目链接。
当配置有 `default_locale` 时，运行 `cardless run <project> --locale <locale>` 可加载 `locales/<locale>/game.toml` 覆盖游戏名、帮助、卡牌和牌堆定义；图片继续由游戏根目录共享。
card 是所有卡牌牌面定义
pile 是所有的牌堆定义。

初始化游戏时，卡牌会按照 card.category 分组，并按 pile.csv 中的牌堆定义顺序寻找第一个兼容的 public pile 放入。pile.category 为空表示兼容任意卡牌；非空时必须与 card.category 完全一致。若某类卡牌找不到兼容的 public pile，初始化失败。
